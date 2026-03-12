import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyProject, ensureDir, exists, hashFile, maybeRun, normalizeRelative, quoteShell, rmrf, runCommand, stripExtendedAttributes } from './fs-utils.mjs';
import { getProjectTypeDescriptor } from './project-type.mjs';
import { DEFAULT_EXCLUDES } from './source-snapshot.mjs';
import { createTarInDockerOrHost, extractTarGz } from './tar.mjs';
import { buildNpmDependencyContextSection } from './context.mjs';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const PYTHON_UV_AUTO_IMAGE_PREFIX = 'ghcr.io/astral-sh/uv';
const PYTHON_UV_AUTO_IMAGE_VARIANTS = ['bookworm-slim', 'bookworm', 'trixie-slim', 'trixie', null];
const PYTHON_REQUIREMENT_FILE_CANDIDATES = ['uv.lock', 'pyproject.toml'];

export function parseTarget(target = 'linux-x64') {
  if (!target.includes('-')) throw new Error(`Invalid target: ${target}`);
  const [platform, arch] = target.split('-', 2);
  return { platform, arch, key: `${platform}-${arch}` };
}

export function defaultDockerPlatform(platform, arch) {
  if (platform !== 'linux') return undefined;
  if (arch === 'x64') return 'linux/amd64';
  if (arch === 'arm64') return 'linux/arm64';
  return undefined;
}

export function shouldUseDocker({ targetPlatform, targetArch }) {
  return process.platform !== targetPlatform || process.arch !== targetArch;
}

export async function prepareTargetArtifacts({
  projectRoot,
  bundleRoot,
  targetPlatform,
  targetArch,
  dockerImage,
  keepTemp = false,
  projectType
}) {
  const descriptor = getProjectTypeDescriptor(projectType);

  if (descriptor.id === 'npm') {
    return prepareNpmTargetArtifacts({
      projectRoot,
      bundleRoot,
      targetPlatform,
      targetArch,
      dockerImage,
      keepTemp,
      descriptor
    });
  }

  return preparePythonUvTargetArtifacts({
    projectRoot,
    bundleRoot,
    targetPlatform,
    targetArch,
    dockerImage,
    keepTemp,
    descriptor
  });
}

async function prepareNpmTargetArtifacts({ projectRoot, bundleRoot, targetPlatform, targetArch, dockerImage, keepTemp, descriptor }) {
  const targetKey = `${targetPlatform}-${targetArch}`;
  const targetOutputDir = path.join(bundleRoot, 'targets', targetKey);
  await ensureDir(targetOutputDir);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `llm-context-cli-${descriptor.id}-${targetKey}-`));
  const workspaceRoot = path.join(tempRoot, 'project');
  const tempArchive = path.join(workspaceRoot, `__llm_context_${descriptor.dependencyArchiveFileName}`);
  const targetArchive = path.join(targetOutputDir, descriptor.dependencyArchiveFileName);
  const sourceLock = path.join(projectRoot, descriptor.lockfileName);
  const targetLock = path.join(workspaceRoot, descriptor.lockfileName);
  const useDocker = shouldUseDocker({ targetPlatform, targetArch });
  const dockerPlatform = defaultDockerPlatform(targetPlatform, targetArch);
  const effectiveDockerImage = dockerImage || descriptor.defaultDockerImage;

  try {
    await copyProject(projectRoot, workspaceRoot, { exclude: [...DEFAULT_EXCLUDES, descriptor.dependencyDirectory] });

    const installRequired = await npmProjectNeedsInstall(workspaceRoot);
    let copiedArchive = false;

    if (installRequired) {
      if (useDocker) {
        const dockerCheck = maybeRun('docker', ['--version']);
        if (!dockerCheck || dockerCheck.status !== 0) {
          throw new Error('Docker is required to build the requested target on this host, but `docker` was not found.');
        }
      }

      const installArgs = await pickNpmInstallArgs(workspaceRoot);
      console.error(`Preparing temporary target workspace for ${targetKey}...`);
      if (useDocker) {
        console.error(`Running ${installArgs.join(' ')} inside Docker (${effectiveDockerImage}).`);
        const cmd = installArgs.map(quoteShell).join(' ');
        const args = [
          'run', '--rm',
          ...(dockerPlatform ? ['--platform', dockerPlatform] : []),
          '-v', `${workspaceRoot}:/work`,
          '-w', '/work',
          effectiveDockerImage,
          'bash', '-lc',
          cmd
        ];
        try {
          runCommand('docker', args, { stdio: 'inherit' });
        } catch (error) {
          throw wrapDockerExecutionError(error);
        }
      } else {
        console.error(`Running ${installArgs.join(' ')} locally.`);
        runCommand(installArgs[0], installArgs.slice(1), { cwd: workspaceRoot, stdio: 'inherit' });
      }

      const installedDependencyDir = path.join(workspaceRoot, descriptor.dependencyDirectory);
      if (!(await exists(installedDependencyDir))) {
        throw new Error(`Target install completed but ${descriptor.dependencyDirectory}/ is missing.`);
      }

      if (!useDocker) {
        stripExtendedAttributes(installedDependencyDir);
        if (await exists(targetLock)) stripExtendedAttributes(targetLock);
      }

      await createTarInDockerOrHost({
        workspaceRoot,
        relativePath: descriptor.dependencyDirectory,
        outputFile: tempArchive,
        useDocker,
        dockerImage: effectiveDockerImage,
        dockerPlatform
      });

      await verifyNodeModulesArchive({ archiveFile: tempArchive, sourceNodeModulesDir: installedDependencyDir });
      await fs.copyFile(tempArchive, targetArchive);
      copiedArchive = true;
    } else {
      console.error(`Skipping target dependency install for ${targetKey}: the project declares no installable npm dependencies and no npm workspaces were detected.`);
    }

    const copiedTargetLock = await copyTargetLockIfNeeded({
      sourceLock,
      targetLock,
      destinationPath: path.join(targetOutputDir, descriptor.lockfileName)
    });

    const contextDependencySection = await buildNpmDependencyContextSection({
      projectRoot,
      installedNodeModulesDir: copiedArchive
        ? path.join(workspaceRoot, descriptor.dependencyDirectory)
        : path.join(projectRoot, descriptor.dependencyDirectory)
    });

    return buildTargetArtifactResult({
      descriptor,
      targetKey,
      installRequired,
      copiedArchive,
      targetArchive,
      copiedTargetLock,
      targetLockPath: path.join(targetOutputDir, descriptor.lockfileName),
      keepTemp,
      tempRoot,
      contextDependencySection
    });
  } finally {
    if (!keepTemp) {
      await rmrf(tempRoot);
    }
  }
}

async function preparePythonUvTargetArtifacts({ projectRoot, bundleRoot, targetPlatform, targetArch, dockerImage, keepTemp, descriptor }) {
  const targetKey = `${targetPlatform}-${targetArch}`;
  const targetOutputDir = path.join(bundleRoot, 'targets', targetKey);
  await ensureDir(targetOutputDir);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `llm-context-cli-${descriptor.id}-${targetKey}-`));
  const workspaceRoot = path.join(tempRoot, 'project');
  const tempArchive = path.join(workspaceRoot, `__llm_context_${descriptor.dependencyArchiveFileName}`);
  const targetArchive = path.join(targetOutputDir, descriptor.dependencyArchiveFileName);
  const sourceLock = path.join(projectRoot, descriptor.lockfileName);
  const targetLock = path.join(workspaceRoot, descriptor.lockfileName);
  const useDocker = shouldUseDocker({ targetPlatform, targetArch });
  const dockerPlatform = defaultDockerPlatform(targetPlatform, targetArch);

  try {
    await copyProject(projectRoot, workspaceRoot, { exclude: [...DEFAULT_EXCLUDES, descriptor.dependencyDirectory] });

    const installRequired = true;
    let copiedArchive = false;
    let effectiveDockerImage = dockerImage || descriptor.defaultDockerImage;
    let resolvedDockerImage = null;

    if (useDocker) {
      const dockerCheck = maybeRun('docker', ['--version']);
      if (!dockerCheck || dockerCheck.status !== 0) {
        throw new Error('Docker is required to build the requested target on this host, but `docker` was not found.');
      }
      if (!effectiveDockerImage) {
        resolvedDockerImage = await resolvePythonUvDockerImage({ projectRoot });
        effectiveDockerImage = resolvedDockerImage.image;
      }
    }

    console.error(`Preparing temporary target workspace for ${targetKey}...`);
    if (useDocker) {
      if (resolvedDockerImage?.automaticallySelected) {
        console.error(`Running uv sync inside Docker (${effectiveDockerImage}, requires-python ${resolvedDockerImage.requiresPython} from ${path.basename(resolvedDockerImage.sourceFile)}).`);
      } else {
        console.error(`Running uv sync inside Docker (${effectiveDockerImage}).`);
      }
      runPythonUvSyncInDocker({ workspaceRoot, dockerImage: effectiveDockerImage, dockerPlatform, frozen: await exists(sourceLock) });
    } else {
      const installArgs = await buildPythonUvSyncArgs({ workspaceRoot, pythonCommand: resolveHostPythonCommand() });
      console.error(`Running ${installArgs.join(' ')} locally.`);
      runCommand(installArgs[0], installArgs.slice(1), { cwd: workspaceRoot, stdio: 'inherit' });
    }

    const installedDependencyDir = path.join(workspaceRoot, descriptor.dependencyDirectory);
    if (!(await exists(installedDependencyDir))) {
      throw new Error(`Target install completed but ${descriptor.dependencyDirectory}/ is missing.`);
    }

    await rewriteVirtualEnvEntryPoints(installedDependencyDir);

    if (!useDocker) {
      stripExtendedAttributes(installedDependencyDir);
      if (await exists(targetLock)) stripExtendedAttributes(targetLock);
    }

    await createTarInDockerOrHost({
      workspaceRoot,
      relativePath: descriptor.dependencyDirectory,
      outputFile: tempArchive,
      useDocker,
      dockerImage: effectiveDockerImage,
      dockerPlatform
    });

    await verifyVirtualEnvArchive({ archiveFile: tempArchive, sourceVenvDir: installedDependencyDir });
    await fs.copyFile(tempArchive, targetArchive);
    copiedArchive = true;

    const copiedTargetLock = await copyTargetLockIfNeeded({
      sourceLock,
      targetLock,
      destinationPath: path.join(targetOutputDir, descriptor.lockfileName)
    });

    return buildTargetArtifactResult({
      descriptor,
      targetKey,
      installRequired,
      copiedArchive,
      targetArchive,
      copiedTargetLock,
      targetLockPath: path.join(targetOutputDir, descriptor.lockfileName),
      keepTemp,
      tempRoot
    });
  } finally {
    if (!keepTemp) {
      await rmrf(tempRoot);
    }
  }
}

function buildTargetArtifactResult({ descriptor, targetKey, installRequired, copiedArchive, targetArchive, copiedTargetLock, targetLockPath, keepTemp, tempRoot, contextDependencySection = '' }) {
  return {
    projectType: descriptor.id,
    targetKey,
    installRequired,
    dependencyArchiveIncluded: copiedArchive,
    dependencyArchivePath: copiedArchive ? targetArchive : null,
    dependencyArchiveFileName: descriptor.dependencyArchiveFileName,
    dependencyDirectory: descriptor.dependencyDirectory,
    targetLockIncluded: copiedTargetLock,
    targetLockPath: copiedTargetLock ? targetLockPath : null,
    lockfileName: descriptor.lockfileName,
    targetNodeModulesIncluded: descriptor.id === 'npm' ? copiedArchive : false,
    nodeModulesTarPath: descriptor.id === 'npm' && copiedArchive ? targetArchive : null,
    tempRoot: keepTemp ? tempRoot : null,
    contextDependencySection
  };
}

async function pickNpmInstallArgs(workspaceRoot) {
  if (await exists(path.join(workspaceRoot, 'package-lock.json'))) {
    return ['npm', 'ci', '--no-audit', '--no-fund'];
  }
  return ['npm', 'install', '--no-audit', '--no-fund'];
}

async function buildPythonUvSyncArgs({ workspaceRoot, pythonCommand }) {
  const args = ['uv', 'sync', '--all-groups', '--no-install-project', '--link-mode', 'copy', '--no-managed-python', '--no-python-downloads'];
  if (await exists(path.join(workspaceRoot, 'uv.lock'))) {
    args.push('--frozen');
  }
  args.push('--python', pythonCommand);
  return args;
}

function resolveHostPythonCommand() {
  for (const candidate of ['python3', 'python']) {
    const probe = maybeRun(candidate, ['-c', 'import sys; print(sys.executable)']);
    if (probe && probe.status === 0) {
      return candidate;
    }
  }
  throw new Error('python3 or python is required to bundle python-uv projects.');
}

function runPythonUvSyncInDocker({ workspaceRoot, dockerImage, dockerPlatform, frozen }) {
  const frozenFlag = frozen ? '--frozen ' : '';
  const command = [
    'set -euo pipefail',
    'PYTHON_BIN="$(command -v python3 || command -v python)"',
    `uv sync --all-groups --no-install-project --link-mode copy --no-managed-python --no-python-downloads ${frozenFlag}--python "$PYTHON_BIN"`
  ].join('; ');
  const args = [
    'run', '--rm',
    ...(dockerPlatform ? ['--platform', dockerPlatform] : []),
    '-v', `${workspaceRoot}:/work`,
    '-w', '/work',
    dockerImage,
    'bash', '-lc',
    command
  ];
  try {
    runCommand('docker', args, { stdio: 'inherit' });
  } catch (error) {
    throw wrapDockerExecutionError(error);
  }
}

function wrapDockerExecutionError(error) {
  const message = error && error.message ? error.message : String(error);
  if (!/Cannot connect to the Docker daemon|error during connect|Is the docker daemon running\?/i.test(message)) {
    return error;
  }

  return new Error([
    'Docker is required to build the requested target on this host, but the Docker daemon is not reachable.',
    'Start Docker or choose a target that matches the current host.',
    '',
    message
  ].join('\n'));
}

export function parseRequiresPythonSpecFromToml(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/^\s*requires-python\s*=\s*"([^"]+)"/m);
  return match ? match[1].trim() : null;
}

export function resolvePythonMinorVersionFromRequiresPython(specifierText) {
  if (typeof specifierText !== 'string') return null;
  const specifiers = specifierText.split(',').map((value) => value.trim()).filter(Boolean);
  const comparatorOrder = ['===', '==', '~=', '>=', '>', '<=', '<'];

  for (const comparator of comparatorOrder) {
    for (const specifier of specifiers) {
      if (!specifier.startsWith(comparator)) continue;
      const version = coercePythonMinorVersion(specifier, comparator);
      if (version) return version;
    }
  }

  for (const specifier of specifiers) {
    const version = coercePythonMinorVersion(specifier);
    if (version) return version;
  }

  return null;
}

export function buildPythonUvDockerImageCandidates(pythonVersion) {
  const normalized = String(pythonVersion || '').trim();
  if (!normalized) return [];

  const imageBase = `${PYTHON_UV_AUTO_IMAGE_PREFIX}:python${normalized}`;
  return [...new Set(PYTHON_UV_AUTO_IMAGE_VARIANTS.map((variant) => (variant ? `${imageBase}-${variant}` : imageBase)).filter(Boolean))];
}

async function resolvePythonUvDockerImage({ projectRoot }) {
  const requirement = await resolvePythonRequirementForProject(projectRoot);
  if (!requirement) {
    throw new Error('Could not determine the required Python version for this python-uv project. Add requires-python to uv.lock or pyproject.toml, or pass --docker-image <image>.');
  }

  const candidates = buildPythonUvDockerImageCandidates(requirement.pythonVersion);
  if (candidates.length === 0) {
    throw new Error(`Could not build a Docker image candidate list from requires-python ${JSON.stringify(requirement.requiresPython)} in ${path.basename(requirement.sourceFile)}. Pass --docker-image <image>.`);
  }

  const failedPulls = [];
  for (const candidate of candidates) {
    const inspectResult = maybeRun('docker', ['image', 'inspect', candidate], { stdio: 'pipe' });
    if (inspectResult && inspectResult.status === 0) {
      console.error(`Using auto-selected Docker image ${candidate} from the local Docker cache.`);
      return {
        image: candidate,
        automaticallySelected: true,
        pulled: false,
        ...requirement
      };
    }

    console.error(`Pulling auto-selected Docker image ${candidate} for requires-python ${requirement.requiresPython} (${path.basename(requirement.sourceFile)}).`);
    const pullResult = maybeRun('docker', ['pull', candidate], { stdio: 'pipe' });
    if (pullResult && pullResult.status === 0) {
      console.error(`Using auto-selected Docker image ${candidate}.`);
      return {
        image: candidate,
        automaticallySelected: true,
        pulled: true,
        ...requirement
      };
    }

    failedPulls.push(formatDockerPullFailure(candidate, pullResult));
  }

  throw new Error(`Unable to automatically pull a Docker image for this python-uv project. Resolved requires-python ${JSON.stringify(requirement.requiresPython)} in ${path.basename(requirement.sourceFile)} and tried: ${candidates.join(', ')}. ${failedPulls.join(' ')}`);
}

async function resolvePythonRequirementForProject(projectRoot) {
  const unresolvedRequirements = [];

  for (const relativePath of PYTHON_REQUIREMENT_FILE_CANDIDATES) {
    const filePath = path.join(projectRoot, relativePath);
    if (!(await exists(filePath))) continue;

    const text = await fs.readFile(filePath, 'utf8');
    const requiresPython = parseRequiresPythonSpecFromToml(text);
    if (!requiresPython) continue;

    const pythonVersion = resolvePythonMinorVersionFromRequiresPython(requiresPython);
    if (pythonVersion) {
      return {
        sourceFile: filePath,
        requiresPython,
        pythonVersion
      };
    }

    unresolvedRequirements.push(`${relativePath} (${requiresPython})`);
  }

  if (unresolvedRequirements.length > 0) {
    throw new Error(`Found requires-python metadata but could not determine a Python major.minor version from: ${unresolvedRequirements.join(', ')}. Pass --docker-image <image>.`);
  }

  return null;
}

function coercePythonMinorVersion(specifier, comparatorHint = null) {
  const versionParts = parsePythonVersionParts(specifier);
  if (!versionParts || versionParts.major !== 3 || versionParts.minor == null) return null;

  const comparator = comparatorHint || specifier.match(/^(===|==|~=|>=|>|<=|<)/)?.[1] || null;
  if (comparator === '<') {
    if ((versionParts.patch == null || versionParts.patch === 0) && versionParts.minor > 0) {
      return formatPythonMinorVersion({ major: versionParts.major, minor: versionParts.minor - 1 });
    }
  }

  return formatPythonMinorVersion(versionParts);
}

function parsePythonVersionParts(text) {
  const match = String(text || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: match[2] == null ? null : Number(match[2]),
    patch: match[3] == null ? null : Number(match[3])
  };
}

function formatPythonMinorVersion({ major, minor }) {
  return `${major}.${minor}`;
}

function formatDockerPullFailure(image, result) {
  if (!result) return `${image} (docker unavailable)`;

  const detail = [result.stderr, result.stdout]
    .filter(Boolean)
    .join('\n')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-1)[0];

  if (detail) return `${image} (${detail})`;
  return `${image} (exit ${result.status})`;
}

async function copyTargetLockIfNeeded({ sourceLock, targetLock, destinationPath }) {
  const sourceLockExists = await exists(sourceLock);
  const targetLockExists = await exists(targetLock);
  if (!targetLockExists) return false;

  const includeTargetLock = !sourceLockExists || (await hashFile(sourceLock)) !== (await hashFile(targetLock));
  if (!includeTargetLock) return false;

  await fs.copyFile(targetLock, destinationPath);
  return true;
}

async function npmProjectNeedsInstall(projectRoot) {
  const packageJson = await readJsonIfExists(path.join(projectRoot, 'package.json'));
  if (!packageJson) {
    throw new Error(`package.json is required to prepare target artifacts: ${projectRoot}`);
  }

  if (packageHasInstallableDependencies(packageJson)) return true;
  if (packageHasWorkspaces(packageJson)) return true;

  const packageLock = await readJsonIfExists(path.join(projectRoot, 'package-lock.json'));
  if (lockfileHasInstalledPackages(packageLock)) return true;

  return false;
}

function packageHasInstallableDependencies(packageJson) {
  return DEPENDENCY_FIELDS.some((field) => hasEntries(packageJson?.[field]));
}

function packageHasWorkspaces(packageJson) {
  if (!packageJson || typeof packageJson !== 'object') return false;
  const { workspaces } = packageJson;
  if (Array.isArray(workspaces)) return workspaces.length > 0;
  if (workspaces && typeof workspaces === 'object') {
    if (Array.isArray(workspaces.packages) && workspaces.packages.length > 0) return true;
    return Object.keys(workspaces).length > 0;
  }
  return false;
}

function hasEntries(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function lockfileHasInstalledPackages(lockfile) {
  if (!lockfile || typeof lockfile !== 'object') return false;

  const packages = lockfile.packages;
  if (packages && typeof packages === 'object') {
    return Object.keys(packages).some((entry) => entry.startsWith('node_modules/'));
  }

  const dependencies = lockfile.dependencies;
  if (dependencies && typeof dependencies === 'object') {
    return Object.keys(dependencies).length > 0;
  }

  return false;
}

async function readJsonIfExists(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function rewriteVirtualEnvEntryPoints(venvDir) {
  const binDir = path.join(venvDir, 'bin');
  if (!(await exists(binDir))) return;

  const entries = await fs.readdir(binDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const scriptPath = path.join(binDir, entry.name);
    const stat = await fs.lstat(scriptPath);
    if (stat.isSymbolicLink()) continue;

    const buffer = await fs.readFile(scriptPath);
    if (buffer.length < 2 || buffer[0] !== 35 || buffer[1] !== 33) continue;

    const text = buffer.toString('utf8');
    const newlineIndex = text.indexOf('\n');
    if (newlineIndex === -1) continue;

    const firstLine = text.slice(0, newlineIndex);
    if (!/^#!.*[\\/]\.venv[\\/](?:bin|Scripts)[\\/]python(?:[0-9.]+)?(?:\s.*)?$/.test(firstLine)) continue;

    const rewritten = `#!/usr/bin/env python3\n${text.slice(newlineIndex + 1)}`;
    await fs.writeFile(scriptPath, rewritten, 'utf8');
    await fs.chmod(scriptPath, stat.mode);
  }
}

export async function verifyNodeModulesArchive({ archiveFile, sourceNodeModulesDir }) {
  const extractRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-context-verify-'));
  try {
    await extractTarGz({ archiveFile, cwd: extractRoot });
    const extractedNodeModules = path.join(extractRoot, 'node_modules');
    if (!(await exists(extractedNodeModules))) {
      throw new Error('Verification failed: extracted archive is missing node_modules/.');
    }

    await verifyNodeModulesBinDirectory({ sourceNodeModulesDir, extractedNodeModules });

    const [sourceEntries, extractedEntries] = await Promise.all([
      collectTreeVerificationMetadata(sourceNodeModulesDir),
      collectTreeVerificationMetadata(extractedNodeModules)
    ]);

    compareTreeVerificationMetadata({
      sourceEntries,
      extractedEntries,
      rootLabel: 'node_modules'
    });
  } finally {
    await rmrf(extractRoot);
  }
}

async function verifyNodeModulesBinDirectory({ sourceNodeModulesDir, extractedNodeModules }) {
  const sourceBinDir = path.join(sourceNodeModulesDir, '.bin');
  const extractedBinDir = path.join(extractedNodeModules, '.bin');
  if (!(await exists(sourceBinDir))) return;

  if (!(await exists(extractedBinDir))) {
    throw new Error('Verification failed: extracted archive is missing node_modules/.bin.');
  }

  const sourceBins = (await fs.readdir(sourceBinDir)).sort();
  const extractedBins = (await fs.readdir(extractedBinDir)).sort();
  if (JSON.stringify(sourceBins) !== JSON.stringify(extractedBins)) {
    throw new Error('Verification failed: node_modules/.bin entries changed during archive creation.');
  }

  for (const binName of sourceBins) {
    const sourceEntry = path.join(sourceBinDir, binName);
    const extractedEntry = path.join(extractedBinDir, binName);
    const [sourceStat, extractedStat] = await Promise.all([fs.lstat(sourceEntry), fs.lstat(extractedEntry)]);
    if (sourceStat.isSymbolicLink() !== extractedStat.isSymbolicLink()) {
      throw new Error(`Verification failed: .bin entry type changed for ${binName}.`);
    }
    if (sourceStat.isSymbolicLink()) {
      const [sourceTarget, extractedTarget] = await Promise.all([fs.readlink(sourceEntry), fs.readlink(extractedEntry)]);
      if (sourceTarget !== extractedTarget) {
        throw new Error(`Verification failed: symlink target changed for node_modules/.bin/${binName}.`);
      }
    }
  }
}

async function collectTreeVerificationMetadata(rootDir) {
  const entries = new Map();

  async function walk(currentDir) {
    const children = await fs.readdir(currentDir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      const absPath = path.join(currentDir, child.name);
      const relPath = normalizeRelative(path.relative(rootDir, absPath));
      const stat = await fs.lstat(absPath);

      if (stat.isDirectory()) {
        entries.set(relPath, {
          type: 'directory'
        });
        await walk(absPath);
        continue;
      }

      if (stat.isSymbolicLink()) {
        entries.set(relPath, {
          type: 'symlink',
          target: await fs.readlink(absPath)
        });
        continue;
      }

      if (stat.isFile()) {
        entries.set(relPath, {
          type: 'file',
          size: stat.size,
          mode: stat.mode & 0o777
        });
      }
    }
  }

  await walk(rootDir);
  return entries;
}

function compareTreeVerificationMetadata({ sourceEntries, extractedEntries, rootLabel }) {
  const sourcePaths = [...sourceEntries.keys()].sort();
  const extractedPaths = [...extractedEntries.keys()].sort();

  for (const relPath of sourcePaths) {
    if (!extractedEntries.has(relPath)) {
      throw new Error(`Verification failed: extracted archive is missing ${rootLabel}/${relPath}.`);
    }
  }

  for (const relPath of extractedPaths) {
    if (!sourceEntries.has(relPath)) {
      throw new Error(`Verification failed: extracted archive contains unexpected ${rootLabel}/${relPath}.`);
    }
  }

  for (const relPath of sourcePaths) {
    const sourceEntry = sourceEntries.get(relPath);
    const extractedEntry = extractedEntries.get(relPath);

    if (sourceEntry.type !== extractedEntry.type) {
      throw new Error(`Verification failed: entry type changed for ${rootLabel}/${relPath}.`);
    }

    if (sourceEntry.type === 'symlink' && sourceEntry.target !== extractedEntry.target) {
      throw new Error(`Verification failed: symlink target changed for ${rootLabel}/${relPath}.`);
    }

    if (sourceEntry.type === 'file') {
      if (sourceEntry.size !== extractedEntry.size) {
        throw new Error(`Verification failed: file size changed for ${rootLabel}/${relPath}.`);
      }
      if (sourceEntry.mode !== extractedEntry.mode) {
        throw new Error(`Verification failed: file mode changed for ${rootLabel}/${relPath}.`);
      }
    }
  }
}

export async function verifyVirtualEnvArchive({ archiveFile, sourceVenvDir }) {
  const extractRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-context-verify-'));
  try {
    await extractTarGz({ archiveFile, cwd: extractRoot });
    const extractedVenvDir = path.join(extractRoot, '.venv');
    if (!(await exists(extractedVenvDir))) {
      throw new Error('Verification failed: extracted archive is missing .venv/.');
    }
    if (!(await exists(path.join(extractedVenvDir, 'pyvenv.cfg')))) {
      throw new Error('Verification failed: extracted archive is missing .venv/pyvenv.cfg.');
    }

    const pythonExecutableRel = await detectVirtualEnvPythonPath(sourceVenvDir);
    if (!pythonExecutableRel) {
      throw new Error('Verification failed: source virtual environment is missing its Python executable.');
    }

    const sourcePython = path.join(sourceVenvDir, pythonExecutableRel);
    const extractedPython = path.join(extractedVenvDir, pythonExecutableRel);
    if (!(await exists(extractedPython))) {
      throw new Error(`Verification failed: extracted archive is missing .venv/${pythonExecutableRel}.`);
    }

    const [sourceStat, extractedStat] = await Promise.all([fs.lstat(sourcePython), fs.lstat(extractedPython)]);
    if (sourceStat.isSymbolicLink() !== extractedStat.isSymbolicLink()) {
      throw new Error(`Verification failed: Python executable type changed for ${pythonExecutableRel}.`);
    }
    if (sourceStat.isSymbolicLink()) {
      const [sourceTarget, extractedTarget] = await Promise.all([fs.readlink(sourcePython), fs.readlink(extractedPython)]);
      if (sourceTarget !== extractedTarget) {
        throw new Error(`Verification failed: Python executable symlink target changed for ${pythonExecutableRel}.`);
      }
    }

    const sampleFiles = await collectVirtualEnvVerificationSamples(sourceVenvDir);
    for (const relPath of sampleFiles) {
      if (!(await exists(path.join(extractedVenvDir, relPath)))) {
        throw new Error(`Verification failed: extracted archive is missing .venv/${relPath}.`);
      }
    }
  } finally {
    await rmrf(extractRoot);
  }
}

async function detectVirtualEnvPythonPath(venvDir) {
  for (const relPath of ['bin/python', 'Scripts/python.exe']) {
    if (await exists(path.join(venvDir, relPath))) {
      return relPath;
    }
  }
  return null;
}

async function collectVirtualEnvVerificationSamples(venvDir) {
  const preferred = ['pyvenv.cfg'];
  const metadataFiles = [];
  const pythonFiles = [];

  async function walk(currentDir, depth = 0) {
    if (depth > 6) return;
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(currentDir, entry.name);
      const rel = normalizeRelative(path.relative(venvDir, abs));
      if (rel.startsWith('bin/') || rel.startsWith('Scripts/')) continue;
      if (rel.includes('/__pycache__/')) continue;
      if (entry.isDirectory()) {
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'METADATA' && metadataFiles.length < 100) metadataFiles.push(rel);
      if ((entry.name.endsWith('.py') || entry.name.endsWith('.so') || entry.name.endsWith('.pyd')) && pythonFiles.length < 100) {
        pythonFiles.push(rel);
      }
    }
  }

  const libDir = path.join(venvDir, 'lib');
  const libExists = await exists(libDir);
  if (libExists) {
    await walk(libDir, 0);
  }

  preferred.push(...metadataFiles.slice(0, 100));
  preferred.push(...pythonFiles.slice(0, 100));
  return preferred;
}
