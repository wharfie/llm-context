import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copySelectedPaths, exists, isGeneratedLlmContextArtifactPath, listFilesRecursive, maybeRun, normalizeRelative, rmrf, stripExtendedAttributes } from './fs-utils.mjs';
import { createTarGzFromList } from './tar.mjs';

export const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.hypothesis',
  '.tox',
  '.nox',
  'build',
  'dist',
  '.llm-context-tmp',
  '.llm_target',
  'LLM_CONTEXT',
  'LLM_CONTEXT.tar.gz',
  'LLM_CONTEXT_source.tar.gz',
  'LLM_CONTEXT_package-lock.json',
  'LLM_CONTEXT_node_modules.tar.gz'
];

export async function discoverProjectFiles(projectRoot, { extraExcludes = [] } = {}) {
  const excludes = new Set([...DEFAULT_EXCLUDES, ...extraExcludes].map((item) => item.replace(/\\/g, '/').replace(/\/$/, '')));
  const gitResult = maybeRun('git', ['-C', projectRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (gitResult && gitResult.status === 0) {
    const files = gitResult.stdout.split('\0').filter(Boolean).map(normalizeRelative).filter((rel) => !isExcluded(rel, excludes));
    files.sort();
    return files;
  }
  const files = await listFilesRecursive(projectRoot);
  return files.filter((rel) => !isExcluded(rel, excludes)).sort();
}

function isExcluded(relPath, excludes) {
  if (isGeneratedLlmContextArtifactPath(relPath)) return true;
  for (const prefix of excludes) {
    if (!prefix) continue;
    if (relPath === prefix || relPath.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export async function createSourceSnapshot({ projectRoot, outputFile, extraExcludes = [] }) {
  const files = await discoverProjectFiles(projectRoot, { extraExcludes });

  if (process.platform !== 'darwin') {
    await createTarGzFromList({ cwd: projectRoot, outputFile, relativePaths: files });
    return { files };
  }

  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-context-source-'));
  try {
    await copySelectedPaths(projectRoot, stagingRoot, files);
    stripExtendedAttributes(stagingRoot);
    await createTarGzFromList({ cwd: stagingRoot, outputFile, relativePaths: files });
    return { files };
  } finally {
    await rmrf(stagingRoot);
  }
}

export async function sourceHasPackageLock(projectRoot) {
  return exists(path.join(projectRoot, 'package-lock.json'));
}
