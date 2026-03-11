import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, normalizeRelative } from './fs-utils.mjs';
import { discoverProjectFiles } from './source-snapshot.mjs';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DEPENDENCY_PACKAGE_JSON_BYTES = 16 * 1024;
const MAX_DEPENDENCY_TYPES_BYTES = 48 * 1024;
const MAX_DEPENDENCY_README_BYTES = 24 * 1024;
const MAX_DEPENDENCY_DETAIL_BYTES = 256 * 1024;
const DIRECT_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const CONTEXT_OMITTED_NPM_FILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb'
]);
const README_NAME_CANDIDATES = ['readme.md', 'readme.mdx', 'readme.txt', 'readme'];
const SEP = '='.repeat(80);

export async function buildContextFile({ projectRoot, outputFile, projectType = 'npm', dependencyContextSection = '' }) {
  const files = await discoverContextFiles(projectRoot, { projectType });
  const handle = await fs.open(outputFile, 'w');
  try {
    await handle.writeFile('# LLM_CONTEXT\n\n');
    if (projectType === 'npm') {
      await handle.writeFile('CONTEXT STRATEGY\n');
      await handle.writeFile('----------------\n');
      await handle.writeFile('- This flattened view is optimized for an LLM prompt window.\n');
      await handle.writeFile('- Exact source and runnable dependency state stay in the other bundle artifacts, not in this text file.\n');
      await handle.writeFile('- Raw npm lockfiles and raw node_modules contents are intentionally omitted here; direct dependencies are summarized separately below.\n\n');
    }

    await handle.writeFile('FILE TREE\n');
    await handle.writeFile('---------\n');
    for (const relPath of files) {
      await handle.writeFile(`${relPath}\n`);
    }
    await handle.writeFile('\nFILE CONTENTS\n');
    await handle.writeFile('-------------\n');
    for (const relPath of files) {
      const absPath = path.join(projectRoot, relPath);
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(absPath);
        await writeFileSection(handle, relPath, `[symlink] -> ${target}\n`);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) continue;
      const buffer = await fs.readFile(absPath);
      if (!isProbablyText(buffer)) continue;
      await writeFileSection(handle, relPath, ensureTrailingNewline(buffer.toString('utf8')));
    }

    if (projectType === 'npm' && dependencyContextSection) {
      await handle.writeFile(`\n${dependencyContextSection}`);
    }
  } finally {
    await handle.close();
  }
}

export async function buildNpmDependencyContextSection({ projectRoot, installedNodeModulesDir = path.join(projectRoot, 'node_modules') }) {
  const rootPackageJsonPath = path.join(projectRoot, 'package.json');
  const rootPackageJson = await readJsonIfExists(rootPackageJsonPath);

  let section = 'DEPENDENCY CONTEXT\n';
  section += '------------------\n';
  section += '- Direct npm dependencies are summarized here so prompt context stays smaller than the runnable bundle.\n';
  section += '- Detailed package file snippets are limited to direct dependencies and selected package.json / README / TypeScript entrypoints.\n';

  if (!rootPackageJson) {
    return `${section}\nNo package.json was available while building npm dependency context.\n`;
  }

  const directDependencies = collectDirectDependencies(rootPackageJson);
  if (directDependencies.length === 0) {
    return `${section}\nNo direct npm dependencies are declared in package.json.\n`;
  }

  const localPackagesByName = await buildLocalPackageMap(projectRoot);
  const installedNodeModulesAvailable = await exists(installedNodeModulesDir);
  const overviewLines = [];
  const detailSections = [];
  const detailBudgetOmissions = [];
  let detailBytesUsed = 0;
  const detailedPackages = new Set();

  for (const dependency of directDependencies) {
    const localResolution = await resolveLocalDependency({ projectRoot, dependency, localPackagesByName });
    if (localResolution) {
      const refs = await collectPackageReferences({
        packageDirAbs: localResolution.packageDirAbs,
        packageDirRel: localResolution.packageDirRel,
        packageJson: localResolution.packageJson
      });
      overviewLines.push(renderDependencyOverviewLine({
        dependency,
        sourceLabel: localResolution.sourceLabel,
        refs
      }));
      continue;
    }

    const installedPackageDir = path.join(installedNodeModulesDir, dependency.name);
    const installedPackageJsonPath = path.join(installedPackageDir, 'package.json');
    if (installedNodeModulesAvailable && await exists(installedPackageJsonPath)) {
      const installedPackageJson = await readJsonIfExists(installedPackageJsonPath);
      const packageDirRel = normalizeRelative(path.join('node_modules', dependency.name));
      const refs = await collectPackageReferences({
        packageDirAbs: installedPackageDir,
        packageDirRel,
        packageJson: installedPackageJson
      });
      overviewLines.push(renderDependencyOverviewLine({
        dependency,
        sourceLabel: 'installed package metadata',
        refs
      }));

      if (!detailedPackages.has(dependency.name)) {
        const detailSection = await buildInstalledDependencyDetailSection({
          dependency,
          packageDirAbs: installedPackageDir,
          packageDirRel,
          refs
        });
        if (detailSection) {
          const detailBytes = Buffer.byteLength(detailSection, 'utf8');
          if (detailBytesUsed + detailBytes <= MAX_DEPENDENCY_DETAIL_BYTES) {
            detailSections.push(detailSection);
            detailBytesUsed += detailBytes;
            detailedPackages.add(dependency.name);
          } else {
            detailBudgetOmissions.push(dependency.name);
          }
        }
      }
      continue;
    }

    overviewLines.push(`- [${dependency.field}] ${dependency.name} -> ${dependency.spec} (manifest only; package metadata was not available while building context)`);
  }

  section += '\n';
  section += overviewLines.join('\n');
  section += '\n';

  if (detailBudgetOmissions.length > 0) {
    const uniqueNames = [...new Set(detailBudgetOmissions)].sort();
    const preview = uniqueNames.slice(0, 5).join(', ');
    const suffix = uniqueNames.length > 5 ? `, +${uniqueNames.length - 5} more` : '';
    section += `\nDetailed dependency file snippets were omitted for ${uniqueNames.length} direct dependencies to keep this flattened context focused: ${preview}${suffix}.\n`;
  }

  if (detailSections.length > 0) {
    section += '\nDEPENDENCY DETAILS\n';
    section += '------------------\n';
    section += detailSections.join('');
  }

  return section;
}

async function discoverContextFiles(projectRoot, { projectType }) {
  const files = await discoverProjectFiles(projectRoot);
  if (projectType !== 'npm') return files;
  return files.filter((relPath) => !shouldOmitFromNpmContext(relPath));
}

function shouldOmitFromNpmContext(relPath) {
  const baseName = path.basename(relPath);
  return CONTEXT_OMITTED_NPM_FILE_NAMES.has(baseName);
}

function collectDirectDependencies(packageJson) {
  const results = [];
  for (const field of DIRECT_DEPENDENCY_FIELDS) {
    const deps = packageJson?.[field];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const name of Object.keys(deps).sort()) {
      results.push({
        field,
        name,
        spec: String(deps[name])
      });
    }
  }
  return results;
}

async function buildLocalPackageMap(projectRoot) {
  const files = await discoverProjectFiles(projectRoot);
  const localPackages = new Map();

  for (const relPath of files) {
    if (relPath === 'package.json' || path.basename(relPath) !== 'package.json') continue;
    const packageJsonPath = path.join(projectRoot, relPath);
    const packageJson = await readJsonIfExists(packageJsonPath);
    if (!packageJson?.name) continue;
    const packageDirRel = normalizeRelative(path.dirname(relPath));
    localPackages.set(packageJson.name, {
      packageDirAbs: path.dirname(packageJsonPath),
      packageDirRel,
      packageJson,
      sourceLabel: 'local package source'
    });
  }

  return localPackages;
}

async function resolveLocalDependency({ projectRoot, dependency, localPackagesByName }) {
  const localSpecifierPath = extractLocalSpecifierPath(dependency.spec);
  if (localSpecifierPath) {
    const candidateDir = path.resolve(projectRoot, localSpecifierPath);
    const relativeCandidateDir = normalizeRelative(path.relative(projectRoot, candidateDir));
    if (relativeCandidateDir && !relativeCandidateDir.startsWith('..')) {
      const packageJsonPath = path.join(candidateDir, 'package.json');
      if (await exists(packageJsonPath)) {
        const packageJson = await readJsonIfExists(packageJsonPath);
        if (packageJson) {
          return {
            packageDirAbs: candidateDir,
            packageDirRel: relativeCandidateDir,
            packageJson,
            sourceLabel: dependency.spec.startsWith('link:') ? 'linked package source' : 'local package source'
          };
        }
      }
    }
  }

  const workspaceMatch = localPackagesByName.get(dependency.name);
  if (workspaceMatch) {
    return workspaceMatch;
  }

  return null;
}

function extractLocalSpecifierPath(specifier) {
  if (specifier.startsWith('file:')) return stripLeadingDotSlash(specifier.slice('file:'.length));
  if (specifier.startsWith('link:')) return stripLeadingDotSlash(specifier.slice('link:'.length));
  return null;
}

function stripLeadingDotSlash(value) {
  return String(value).replace(/^\.\//, '');
}

async function collectPackageReferences({ packageDirAbs, packageDirRel, packageJson }) {
  const refs = {
    packageJson: normalizeRelative(path.join(packageDirRel, 'package.json')),
    types: null,
    readme: null
  };

  const typesRelPath = await resolveTypesReference({ packageDirAbs, packageDirRel, packageJson });
  if (typesRelPath) refs.types = typesRelPath;

  const readmeRelPath = await resolveReadmeReference({ packageDirAbs, packageDirRel });
  if (readmeRelPath) refs.readme = readmeRelPath;

  return refs;
}

async function resolveTypesReference({ packageDirAbs, packageDirRel, packageJson }) {
  const candidatePaths = [];
  if (typeof packageJson?.types === 'string') candidatePaths.push(packageJson.types);
  if (typeof packageJson?.typings === 'string') candidatePaths.push(packageJson.typings);

  const exportsTypes = extractTypesPathFromExports(packageJson?.exports);
  if (exportsTypes) candidatePaths.push(exportsTypes);

  candidatePaths.push('index.d.ts');
  candidatePaths.push('dist/index.d.ts');

  for (const candidate of candidatePaths) {
    const normalizedCandidate = normalizeRelative(stripLeadingDotSlash(candidate));
    if (!normalizedCandidate) continue;
    const absCandidate = path.join(packageDirAbs, normalizedCandidate);
    if (await exists(absCandidate)) {
      return normalizeRelative(path.join(packageDirRel, normalizedCandidate));
    }
  }

  return null;
}

function extractTypesPathFromExports(exportsField) {
  if (!exportsField) return null;
  if (typeof exportsField === 'string') {
    return exportsField.endsWith('.d.ts') ? exportsField : null;
  }
  if (Array.isArray(exportsField)) {
    for (const entry of exportsField) {
      const candidate = extractTypesPathFromExports(entry);
      if (candidate) return candidate;
    }
    return null;
  }
  if (typeof exportsField !== 'object') return null;
  if (typeof exportsField.types === 'string') return exportsField.types;
  if (exportsField['.']) {
    const candidate = extractTypesPathFromExports(exportsField['.']);
    if (candidate) return candidate;
  }
  for (const value of Object.values(exportsField)) {
    const candidate = extractTypesPathFromExports(value);
    if (candidate) return candidate;
  }
  return null;
}

async function resolveReadmeReference({ packageDirAbs, packageDirRel }) {
  let entries;
  try {
    entries = await fs.readdir(packageDirAbs, { withFileTypes: true });
  } catch {
    return null;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!README_NAME_CANDIDATES.includes(entry.name.toLowerCase())) continue;
    return normalizeRelative(path.join(packageDirRel, entry.name));
  }
  return null;
}

function renderDependencyOverviewLine({ dependency, sourceLabel, refs }) {
  const parts = [`${sourceLabel}: ${refs.packageJson}`];
  if (refs.types) parts.push(`types: ${refs.types}`);
  if (refs.readme) parts.push(`readme: ${refs.readme}`);
  return `- [${dependency.field}] ${dependency.name} -> ${dependency.spec} (${parts.join('; ')})`;
}

async function buildInstalledDependencyDetailSection({ dependency, packageDirAbs, packageDirRel, refs }) {
  const files = [];

  const packageJsonContent = await readBoundedTextFile(path.join(packageDirAbs, 'package.json'), MAX_DEPENDENCY_PACKAGE_JSON_BYTES);
  if (packageJsonContent) {
    files.push({ relPath: refs.packageJson, content: packageJsonContent });
  }

  if (refs.types) {
    const typesContent = await readBoundedTextFile(resolvePackageRelPath(packageDirAbs, packageDirRel, refs.types), MAX_DEPENDENCY_TYPES_BYTES);
    if (typesContent) {
      files.push({ relPath: refs.types, content: typesContent });
    }
  }

  if (refs.readme) {
    const readmeContent = await readBoundedTextFile(resolvePackageRelPath(packageDirAbs, packageDirRel, refs.readme), MAX_DEPENDENCY_README_BYTES);
    if (readmeContent) {
      files.push({ relPath: refs.readme, content: readmeContent });
    }
  }

  if (files.length === 0) return '';

  let section = `${SEP}\nDEPENDENCY: ${dependency.name}\nFIELD: ${dependency.field}\nSPEC: ${dependency.spec}\nSOURCE: installed node_modules\n${SEP}\n`;
  for (const file of files) {
    section += `${SEP}\nFILE: ${file.relPath}\n${SEP}\n`;
    section += file.content;
  }
  return section;
}

function resolvePackageRelPath(packageDirAbs, packageDirRel, relPathFromContext) {
  const suffix = normalizeRelative(path.relative(packageDirRel, relPathFromContext));
  return path.join(packageDirAbs, suffix);
}

async function readBoundedTextFile(filePath, maxBytes) {
  let buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    return null;
  }
  if (!isProbablyText(buffer)) return null;

  const truncated = buffer.length > maxBytes;
  const boundedBuffer = truncated ? buffer.subarray(0, maxBytes) : buffer;
  let text = boundedBuffer.toString('utf8');
  if (!text.endsWith('\n')) text += '\n';
  if (truncated) {
    text += `[truncated after ${maxBytes} bytes]\n`;
  }
  return text;
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

async function writeFileSection(handle, relPath, text) {
  await handle.writeFile(`${SEP}\nFILE: ${relPath}\n${SEP}\n`);
  await handle.writeFile(ensureTrailingNewline(text));
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function isProbablyText(buffer) {
  if (!buffer.length) return true;
  let suspicious = 0;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 14 && byte < 32 && byte !== 9)) suspicious += 1;
  }
  return suspicious / sample.length < 0.02;
}
