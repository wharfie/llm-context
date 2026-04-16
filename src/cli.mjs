import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildContextFile } from './context.mjs';
import { parseTarget, prepareTargetArtifacts } from './deps.mjs';
import { ensureDir, exists, hashFile, stripExtendedAttributes, writeJson, rmrf } from './fs-utils.mjs';
import { detectProjectType } from './project-type.mjs';
import { buildBundleReadme } from './readme.mjs';
import { buildBundleScripts } from './scripts.mjs';
import { createSourceSnapshot } from './source-snapshot.mjs';
import { createTarGzFromDir, extractTarGz } from './tar.mjs';

export async function main(argv = process.argv.slice(2)) {
  const options = applyImpliedOptions(parseArgs(argv));
  if (options.help) {
    printHelp();
    return;
  }

  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const projectType = await detectProjectType(projectRoot, options.projectType || 'auto');
  const outputFile = path.resolve(projectRoot, options.output || defaultOutputFileName(projectRoot));
  const { platform: targetPlatform, arch: targetArch, key: targetKey } = resolveTargetOptions(options);

  console.error(`Project root: ${projectRoot}`);
  console.error(`Project type: ${projectType.humanName}`);
  console.error(`Target: ${targetPlatform}/${targetArch}`);

  const tempBundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-context-bundle-'));
  const bundleDir = path.join(tempBundleRoot, 'LLM_CONTEXT');
  await ensureDir(bundleDir);

  try {
    const contextPath = path.join(bundleDir, 'LLM_CONTEXT');

    const sourceSnapshotPath = path.join(bundleDir, 'LLM_CONTEXT_source.tar.gz');
    await createSourceSnapshot({ projectRoot, outputFile: sourceSnapshotPath });
    console.error(`Wrote ${sourceSnapshotPath}`);

    const depsMeta = options.slim
      ? buildSlimTargetArtifactsMeta()
      : await prepareTargetArtifacts({
          projectRoot,
          bundleRoot: bundleDir,
          targetPlatform,
          targetArch,
          dockerImage: options.dockerImage,
          keepTemp: Boolean(options.keepTemp),
          projectType: projectType.id,
          sourceOnly: Boolean(options.sourceOnly)
        });
    if (options.slim) {
      console.error('Slim bundle requested; omitting target runtime dependencies, repo.tar.gz, and offline helper scripts to keep the archive context-first and upload-friendly.');
    } else if (options.sourceOnly) {
      console.error('Source-only context requested; target runtime artifacts are still captured separately for offline validation.');
    }
    if (options.slim) {
      console.error(`Skipped targets/${targetKey}/${projectType.dependencyArchiveFileName} because --slim intentionally omits ${projectType.dependencyDirectory}/ from the bundle.`);
    } else if (depsMeta.dependencyArchiveIncluded) {
      console.error(`Wrote ${depsMeta.dependencyArchivePath}`);
    } else {
      console.error(`Skipped targets/${targetKey}/${projectType.dependencyArchiveFileName} because the target install did not need ${projectType.dependencyDirectory}/.`);
    }
    if (depsMeta.targetLockIncluded) {
      console.error(`Wrote ${depsMeta.targetLockPath}`);
    }

    await buildContextFile({
      projectRoot,
      outputFile: contextPath,
      projectType: projectType.id,
      dependencyContextSection: depsMeta.contextDependencySection,
      sourceOnly: Boolean(options.sourceOnly),
      slim: Boolean(options.slim)
    });
    console.error(`Wrote ${contextPath}`);

    const preassembledRepoIncluded = !options.noPreassembledRepo;
    const preassembledRepoEmbedsDependencies = preassembledRepoIncluded
      && depsMeta.dependencyArchiveIncluded
      && Boolean(options.embedDependenciesInRepo || options.embedNodeModulesInRepo);

    let preassembledRepoPath = null;
    if (preassembledRepoIncluded) {
      preassembledRepoPath = await buildPreassembledRepo({
        bundleDir,
        sourceSnapshotPath,
        targetKey,
        projectType,
        targetDependencyArchiveIncluded: depsMeta.dependencyArchiveIncluded,
        targetLockIncluded: depsMeta.targetLockIncluded,
        embedDependencies: preassembledRepoEmbedsDependencies
      });
      if (preassembledRepoEmbedsDependencies) {
        console.error(`Wrote ${preassembledRepoPath} with embedded ${projectType.dependencyDirectory}.`);
      } else if (depsMeta.dependencyArchiveIncluded) {
        console.error(`Wrote ${preassembledRepoPath} without ${projectType.dependencyDirectory} to avoid duplicating bundled target dependencies.`);
      } else {
        console.error(`Wrote ${preassembledRepoPath}`);
      }
    } else {
      console.error('Skipped repo.tar.gz because --no-preassembled-repo was requested.');
    }

    const readmePath = await buildBundleReadme({
      bundleDir,
      archiveFileName: path.basename(outputFile),
      targetKey,
      projectType,
      dependencyArchiveIncluded: depsMeta.dependencyArchiveIncluded,
      targetLockIncluded: depsMeta.targetLockIncluded,
      preassembledRepoIncluded,
      preassembledRepoEmbedsDependencies,
      sourceOnly: Boolean(options.sourceOnly),
      slim: Boolean(options.slim)
    });
    const scriptPaths = options.slim
      ? { assembleScriptPath: null, verifyScriptPath: null }
      : await buildBundleScripts({
          bundleDir,
          targetKey,
          projectType,
          preassembledRepoIncluded,
          preassembledRepoEmbedsDependencies,
          sourceOnly: Boolean(options.sourceOnly)
        });

    const dependencyArchiveRelativePath = depsMeta.dependencyArchiveIncluded
      ? `targets/${targetKey}/${projectType.dependencyArchiveFileName}`
      : null;
    const lockfileRelativePath = depsMeta.targetLockIncluded
      ? `targets/${targetKey}/${projectType.lockfileName}`
      : null;

    const manifest = {
      formatVersion: 6,
      project: {
        type: projectType.id,
        manifestFile: projectType.manifestFile,
        dependencyDirectory: projectType.dependencyDirectory,
        dependencyArchiveFileName: projectType.dependencyArchiveFileName,
        lockfileName: projectType.lockfileName
      },
      target: { platform: targetPlatform, arch: targetArch, key: targetKey },
      install: {
        required: depsMeta.installRequired,
        dependencyArchiveIncluded: depsMeta.dependencyArchiveIncluded,
        dependencyArchivePath: dependencyArchiveRelativePath,
        lockfileIncluded: depsMeta.targetLockIncluded,
        lockfilePath: lockfileRelativePath,
        nodeModulesIncluded: projectType.id === 'npm' ? depsMeta.dependencyArchiveIncluded : false
      },
      bundleOptions: {
        slim: Boolean(options.slim),
        sourceOnly: Boolean(options.sourceOnly),
        preassembledRepoIncluded,
        preassembledRepoEmbedsDependencies,
        preassembledRepoEmbedsNodeModules: projectType.id === 'npm' ? preassembledRepoEmbedsDependencies : false
      },
      artifacts: {
        context: { path: 'LLM_CONTEXT', sha256: await hashFile(contextPath) },
        sourceSnapshot: { path: 'LLM_CONTEXT_source.tar.gz', sha256: await hashFile(sourceSnapshotPath) },
        preassembledRepo: preassembledRepoPath
          ? {
              path: 'repo.tar.gz',
              sha256: await hashFile(preassembledRepoPath),
              embedsDependencies: preassembledRepoEmbedsDependencies,
              embedsNodeModules: projectType.id === 'npm' ? preassembledRepoEmbedsDependencies : false
            }
          : null,
        targetDependencies: depsMeta.dependencyArchiveIncluded
          ? {
              path: dependencyArchiveRelativePath,
              sha256: await hashFile(path.join(bundleDir, dependencyArchiveRelativePath)),
              kind: projectType.dependencyDirectory
            }
          : null,
        targetNodeModules: projectType.id === 'npm' && depsMeta.dependencyArchiveIncluded
          ? {
              path: `targets/${targetKey}/node_modules.tar.gz`,
              sha256: await hashFile(path.join(bundleDir, 'targets', targetKey, 'node_modules.tar.gz'))
            }
          : null,
        targetLock: depsMeta.targetLockIncluded
          ? {
              path: lockfileRelativePath,
              sha256: await hashFile(path.join(bundleDir, lockfileRelativePath))
            }
          : null,
        readme: { path: 'README.md', sha256: await hashFile(readmePath) },
        assembleScript: scriptPaths.assembleScriptPath
          ? { path: 'assemble.offline.sh', sha256: await hashFile(scriptPaths.assembleScriptPath) }
          : null,
        verifyScript: scriptPaths.verifyScriptPath
          ? { path: 'verify.offline.sh', sha256: await hashFile(scriptPaths.verifyScriptPath) }
          : null
      }
    };
    await writeJson(path.join(bundleDir, 'MANIFEST.json'), manifest);

    stripExtendedAttributes(bundleDir);
    await createTarGzFromDir({ cwd: tempBundleRoot, outputFile, relativePath: 'LLM_CONTEXT' });
    console.error(`Wrote ${outputFile}`);
  } finally {
    if (!options.keepTemp) {
      await fs.rm(tempBundleRoot, { recursive: true, force: true });
    } else {
      console.error(`Kept temp bundle dir: ${tempBundleRoot}`);
    }
  }
}

function buildSlimTargetArtifactsMeta() {
  return {
    installRequired: false,
    dependencyArchiveIncluded: false,
    dependencyArchivePath: null,
    targetLockIncluded: false,
    targetLockPath: null,
    contextDependencySection: ''
  };
}

function applyImpliedOptions(options) {
  if (options.slim) {
    options.sourceOnly = true;
    options.noPreassembledRepo = true;
  }
  return options;
}

async function buildPreassembledRepo({
  bundleDir,
  sourceSnapshotPath,
  targetKey,
  projectType,
  targetDependencyArchiveIncluded,
  targetLockIncluded,
  embedDependencies
}) {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-context-preassembled-'));
  const repoDir = path.join(stagingRoot, 'repo');
  const outputFile = path.join(bundleDir, 'repo.tar.gz');
  const targetDir = path.join(bundleDir, 'targets', targetKey);
  const targetLockPath = path.join(targetDir, projectType.lockfileName);
  const sourceLockPath = path.join(repoDir, projectType.lockfileName);
  const targetDependencyArchivePath = path.join(targetDir, projectType.dependencyArchiveFileName);

  try {
    await ensureDir(repoDir);
    await extractTarGz({ archiveFile: sourceSnapshotPath, cwd: repoDir });

    if (targetLockIncluded && (await exists(targetLockPath))) {
      if (!(await exists(sourceLockPath))) {
        await fs.copyFile(targetLockPath, sourceLockPath);
      } else {
        const targetLockDest = path.join(repoDir, '.llm_context_target', projectType.lockfileName);
        await ensureDir(path.dirname(targetLockDest));
        await fs.copyFile(targetLockPath, targetLockDest);
      }
    }

    if (embedDependencies && targetDependencyArchiveIncluded && (await exists(targetDependencyArchivePath))) {
      await extractTarGz({ archiveFile: targetDependencyArchivePath, cwd: repoDir });
    }

    stripExtendedAttributes(stagingRoot);
    await createTarGzFromDir({ cwd: stagingRoot, outputFile, relativePath: 'repo' });
    return outputFile;
  } finally {
    await rmrf(stagingRoot);
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--output' || arg === '-o') {
      const { value, nextIndex } = readRequiredOptionValue(argv, index, arg);
      options.output = value;
      index = nextIndex;
      continue;
    }
    if (arg === '--project-root') {
      const { value, nextIndex } = readRequiredOptionValue(argv, index, arg);
      options.projectRoot = value;
      index = nextIndex;
      continue;
    }
    if (arg === '--project-type') {
      const { value, nextIndex } = readRequiredOptionValue(argv, index, arg);
      options.projectType = value;
      index = nextIndex;
      continue;
    }
    if (arg === '--platform') {
      const { value, nextIndex } = readRequiredOptionValue(argv, index, arg);
      options.platform = value;
      index = nextIndex;
      continue;
    }
    if (arg === '--arch') {
      const { value, nextIndex } = readRequiredOptionValue(argv, index, arg);
      options.arch = value;
      index = nextIndex;
      continue;
    }
    if (arg === '--target') {
      const { value, nextIndex } = readRequiredOptionValue(argv, index, arg);
      const target = parseTarget(value);
      options.platform = target.platform;
      options.arch = target.arch;
      index = nextIndex;
      continue;
    }
    if (arg === '--docker-image') {
      const { value, nextIndex } = readRequiredOptionValue(argv, index, arg);
      options.dockerImage = value;
      index = nextIndex;
      continue;
    }
    if (arg === '--keep-temp') {
      options.keepTemp = true;
      continue;
    }
    if (arg === '--slim' || arg === '-s') {
      options.slim = true;
      continue;
    }
    if (arg === '--source-only') {
      options.sourceOnly = true;
      continue;
    }
    if (arg === '--no-preassembled-repo') {
      options.noPreassembledRepo = true;
      continue;
    }
    if (arg === '--embed-dependencies-in-repo') {
      options.embedDependenciesInRepo = true;
      continue;
    }
    if (arg === '--embed-node-modules-in-repo') {
      options.embedNodeModulesInRepo = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readRequiredOptionValue(argv, index, flagName) {
  const nextIndex = index + 1;
  const value = argv[nextIndex];
  if (value == null || value.startsWith('-')) {
    throw new Error(`${flagName} requires a value.`);
  }
  return { value, nextIndex };
}

function resolveTargetOptions(options) {
  const platform = options.platform || 'linux';
  const arch = options.arch || 'x64';
  return parseTarget(`${platform}-${arch}`);
}

function printHelp() {
  console.log(`llm-context\n\nUsage:\n  llm-context [options]\n\nOptions:\n  --output, -o <file>              Output tar.gz path (default: ./LLM_CONTEXT-<folder-name>.tar.gz)\n  --project-root <dir>             Project root (default: cwd)\n  --project-type <type>            auto|npm|python-uv (default: auto)\n  --target <platform-arch>         Target tuple (default: linux-x64)\n  --platform <platform>            Target platform\n  --arch <arch>                    Target arch\n  --docker-image <image>           Docker image for cross-target installs (default: node:22-bookworm-slim for npm; python-uv auto-selects a uv image from requires-python)\n  --keep-temp                      Keep temporary bundle/workspace directories\n  --slim, -s                       Create a context-first slim bundle; implies --source-only and omits target dependencies, repo.tar.gz, and offline helper scripts\n  --source-only                    Keep the flattened LLM_CONTEXT focused on source files while still bundling target dependencies\n  --no-preassembled-repo           Omit repo.tar.gz entirely\n  --embed-dependencies-in-repo     Also embed node_modules/.venv inside repo.tar.gz\n  --embed-node-modules-in-repo     Backward-compatible alias for --embed-dependencies-in-repo\n  --help, -h                       Show help\n`);
}

function defaultOutputFileName(projectRoot) {
  const folderName = path.basename(projectRoot) || 'project';
  return `LLM_CONTEXT-${folderName}.tar.gz`;
}
