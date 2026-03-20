import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, maybeRun, quoteShell, runCommand, stripExtendedAttributes } from './fs-utils.mjs';

let cachedTarCommand = null;
const cachedCreateArgs = new Map();
const cachedFlagSupport = new Map();

function tarEnv() {
  return process.platform === 'darwin'
    ? {
        COPYFILE_DISABLE: '1',
        COPY_EXTENDED_ATTRIBUTES_DISABLE: '1'
      }
    : {};
}

function tarCommand() {
  if (cachedTarCommand) return cachedTarCommand;

  if (process.platform === 'darwin') {
    const gtar = maybeRun('gtar', ['--version']);
    if (gtar && gtar.status === 0) {
      cachedTarCommand = 'gtar';
      return cachedTarCommand;
    }
  }

  cachedTarCommand = 'tar';
  return cachedTarCommand;
}

async function tarSupportsCreateFlag(flag) {
  const cacheKey = `${process.platform}:${tarCommand()}:${flag}`;
  if (cachedFlagSupport.has(cacheKey)) return cachedFlagSupport.get(cacheKey);

  const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-context-tar-probe-'));
  try {
    const archiveFile = path.join(probeRoot, 'probe.tar.gz');
    const probeFile = path.join(probeRoot, 'probe.txt');
    await fs.writeFile(probeFile, 'probe\n', 'utf8');

    const result = maybeRun(
      tarCommand(),
      ['-czf', archiveFile, flag, '-C', probeRoot, 'probe.txt'],
      { env: tarEnv() }
    );
    const supported = Boolean(result && result.status === 0);
    cachedFlagSupport.set(cacheKey, supported);
    return supported;
  } finally {
    await fs.rm(probeRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function tarCreateExtraArgs() {
  const cacheKey = `${process.platform}:${tarCommand()}`;
  if (cachedCreateArgs.has(cacheKey)) return cachedCreateArgs.get(cacheKey);

  const candidates = [
    '--no-xattrs',
    '--no-acls',
    '--no-fflags',
    '--no-selinux'
  ];

  if (process.platform === 'darwin') {
    candidates.unshift('--disable-copyfile');
    candidates.unshift('--no-mac-metadata');
  }

  const supportedFlags = [];
  for (const flag of candidates) {
    if (await tarSupportsCreateFlag(flag)) {
      supportedFlags.push(flag);
    }
  }

  cachedCreateArgs.set(cacheKey, supportedFlags);
  return supportedFlags;
}

export function resetTarCapabilityCacheForTesting() {
  cachedTarCommand = null;
  cachedCreateArgs.clear();
  cachedFlagSupport.clear();
}

export async function createTarGzFromList({ cwd, outputFile, relativePaths }) {
  await ensureDir(path.dirname(outputFile));
  const listFile = path.join(os.tmpdir(), `llm-context-list-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    const content = relativePaths.map((item) => `${item}\n`).join('');
    await fs.writeFile(listFile, content, 'utf8');
    runCommand(tarCommand(), ['-czf', outputFile, ...(await tarCreateExtraArgs()), '-C', cwd, '-T', listFile], { env: tarEnv() });
    stripExtendedAttributes(outputFile);
  } finally {
    await fs.rm(listFile, { force: true }).catch(() => {});
  }
}

export async function createTarGzFromDir({ cwd, outputFile, relativePath }) {
  await ensureDir(path.dirname(outputFile));
  runCommand(tarCommand(), ['-czf', outputFile, ...(await tarCreateExtraArgs()), '-C', cwd, relativePath], { env: tarEnv() });
  stripExtendedAttributes(outputFile);
}

export async function extractTarGz({ archiveFile, cwd }) {
  await ensureDir(cwd);
  runCommand(tarCommand(), ['-xzf', archiveFile, '-C', cwd], { env: tarEnv() });
}

export async function createTarInDockerOrHost({ workspaceRoot, relativePath, outputFile, useDocker, dockerImage, dockerPlatform }) {
  await ensureDir(path.dirname(outputFile));
  const tempArchive = path.join(workspaceRoot, `.__llm_context_${path.basename(outputFile)}`);
  await fs.rm(tempArchive, { force: true }).catch(() => {});
  if (useDocker) {
    const args = [
      'run', '--rm',
      ...(dockerPlatform ? ['--platform', dockerPlatform] : []),
      '-v', `${workspaceRoot}:/work`,
      '-w', '/work',
      dockerImage,
      'bash', '-lc',
      `tar -czf ${quoteShell(path.basename(tempArchive))} -C /work ${quoteShell(relativePath)}`
    ];
    runCommand('docker', args, { env: tarEnv(), stdio: 'inherit' });
  } else {
    runCommand(tarCommand(), ['-czf', tempArchive, ...(await tarCreateExtraArgs()), '-C', workspaceRoot, relativePath], { env: tarEnv(), stdio: 'inherit' });
  }
  await fs.rename(tempArchive, outputFile);
  stripExtendedAttributes(outputFile);
}
