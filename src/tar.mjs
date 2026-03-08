import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, maybeRun, quoteShell, runCommand } from './fs-utils.mjs';

let cachedTarHelpText = null;
let cachedCreateArgs = null;

function tarEnv() {
  return process.platform === 'darwin' ? { COPYFILE_DISABLE: '1' } : {};
}

function tarHelpText() {
  if (cachedTarHelpText !== null) return cachedTarHelpText;
  const result = maybeRun('tar', ['--help']);
  cachedTarHelpText = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  return cachedTarHelpText;
}

function tarSupports(flag) {
  return tarHelpText().includes(flag);
}

function tarCreateExtraArgs() {
  if (cachedCreateArgs) return cachedCreateArgs;

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

  cachedCreateArgs = candidates.filter((flag) => tarSupports(flag));
  return cachedCreateArgs;
}

export async function createTarGzFromList({ cwd, outputFile, relativePaths }) {
  await ensureDir(path.dirname(outputFile));
  const listFile = path.join(os.tmpdir(), `llm-context-list-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    const content = relativePaths.map((item) => `${item}\n`).join('');
    await fs.writeFile(listFile, content, 'utf8');
    runCommand('tar', ['-czf', outputFile, ...tarCreateExtraArgs(), '-C', cwd, '-T', listFile], { env: tarEnv() });
  } finally {
    await fs.rm(listFile, { force: true }).catch(() => {});
  }
}

export async function createTarGzFromDir({ cwd, outputFile, relativePath }) {
  await ensureDir(path.dirname(outputFile));
  runCommand('tar', ['-czf', outputFile, ...tarCreateExtraArgs(), '-C', cwd, relativePath], { env: tarEnv() });
}

export async function extractTarGz({ archiveFile, cwd }) {
  await ensureDir(cwd);
  runCommand('tar', ['-xzf', archiveFile, '-C', cwd], { env: tarEnv() });
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
    runCommand('tar', ['-czf', tempArchive, ...tarCreateExtraArgs(), '-C', workspaceRoot, relativePath], { env: tarEnv(), stdio: 'inherit' });
  }
  await fs.rename(tempArchive, outputFile);
}
