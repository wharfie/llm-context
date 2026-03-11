import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function rmrf(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

export async function copyProject(sourceRoot, destRoot, { exclude = [] } = {}) {
  const normalizedExcludes = exclude.map((value) => normalizeRelative(value));
  await fs.cp(sourceRoot, destRoot, {
    recursive: true,
    preserveTimestamps: true,
    filter: (src) => {
      const rel = normalizeRelative(path.relative(sourceRoot, src));
      if (!rel) return true;
      if (isGeneratedLlmContextArtifactPath(rel)) return false;
      return !normalizedExcludes.some((pattern) => matchesExclude(rel, pattern));
    }
  });
}

export async function copySelectedPaths(sourceRoot, destRoot, relativePaths) {
  const seenDirs = new Set();
  for (const relPath of relativePaths) {
    const sourcePath = path.join(sourceRoot, relPath);
    const destPath = path.join(destRoot, relPath);
    const destDir = path.dirname(destPath);
    if (!seenDirs.has(destDir)) {
      await ensureDir(destDir);
      seenDirs.add(destDir);
    }

    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(sourcePath);
      await fs.symlink(target, destPath);
      continue;
    }

    if (!stat.isFile()) continue;
    await fs.copyFile(sourcePath, destPath);
    await fs.chmod(destPath, stat.mode);
  }
}

export function normalizeRelative(relPath) {
  return relPath.split(path.sep).join('/').replace(/^\.\//, '').replace(/\/$/, '');
}

export function isGeneratedLlmContextArtifactPath(relPath) {
  const normalized = normalizeRelative(relPath);
  if (!normalized) return false;

  const topLevelEntry = normalized.split('/', 1)[0];
  if (topLevelEntry === 'LLM_CONTEXT') return true;
  if (topLevelEntry === 'LLM_CONTEXT_source.tar.gz') return true;
  if (topLevelEntry === 'LLM_CONTEXT_package-lock.json') return true;
  if (topLevelEntry === 'LLM_CONTEXT_node_modules.tar.gz') return true;
  return /^LLM_CONTEXT(?:-[^/]+)?\.tar\.gz$/.test(topLevelEntry);
}

function matchesExclude(relPath, pattern) {
  if (!pattern) return false;
  if (relPath === pattern) return true;
  return relPath.startsWith(`${pattern}/`);
}

export async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

export async function hashString(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function runCommand(command, args, options = {}) {
  const passthroughOutput = options.stdio === 'inherit';
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    stdio: passthroughOutput ? 'pipe' : (options.stdio ?? 'pipe'),
    input: options.input,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 256
  });
  if (passthroughOutput && result.status === 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const pretty = [command, ...args].join(' ');
    const stdout = result.stdout ? `\nSTDOUT:\n${result.stdout}` : '';
    const stderr = result.stderr ? `\nSTDERR:\n${result.stderr}` : '';
    throw new Error(`Command failed (${result.status}): ${pretty}${stdout}${stderr}`);
  }
  return result;
}

export function maybeRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    input: options.input,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 64
  });
  if (result.error && result.error.code === 'ENOENT') return null;
  return result;
}

export async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export async function listFilesRecursive(rootDir) {
  const results = [];
  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(currentDir, entry.name);
      const rel = normalizeRelative(path.relative(rootDir, abs));
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        results.push(rel);
      }
    }
  }
  await walk(rootDir);
  return results;
}

export function stripExtendedAttributes(targetPath) {
  if (process.platform !== 'darwin') return;
  const xattrHelp = maybeRun('xattr', ['-h']);
  if (!xattrHelp || xattrHelp.status !== 0) return;
  const result = maybeRun('xattr', ['-rc', targetPath]);
  if (result && result.status !== 0) {
    const stderr = result.stderr ? ` ${result.stderr.trim()}` : '';
    console.error(`Warning: failed to strip macOS extended attributes from ${targetPath}.${stderr}`.trim());
  }
}
