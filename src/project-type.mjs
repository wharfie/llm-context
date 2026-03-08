import path from 'node:path';
import { exists } from './fs-utils.mjs';

export const PROJECT_TYPES = {
  npm: {
    id: 'npm',
    humanName: 'Node.js + npm',
    manifestFile: 'package.json',
    dependencyDirectory: 'node_modules',
    dependencyArchiveFileName: 'node_modules.tar.gz',
    lockfileName: 'package-lock.json',
    defaultDockerImage: 'node:22-bookworm-slim'
  },
  'python-uv': {
    id: 'python-uv',
    humanName: 'Python + uv',
    manifestFile: 'pyproject.toml',
    dependencyDirectory: '.venv',
    dependencyArchiveFileName: 'venv.tar.gz',
    lockfileName: 'uv.lock',
    defaultDockerImage: null
  }
};

export function normalizeProjectType(value = 'auto') {
  const normalized = String(value).trim().toLowerCase();
  switch (normalized) {
    case 'auto':
      return 'auto';
    case 'npm':
    case 'node':
    case 'node-npm':
      return 'npm';
    case 'python':
    case 'uv':
    case 'python-uv':
    case 'python+uv':
      return 'python-uv';
    default:
      throw new Error(`Unsupported project type: ${value}`);
  }
}

export function getProjectTypeDescriptor(projectType) {
  const normalized = normalizeProjectType(projectType);
  if (normalized === 'auto') {
    throw new Error('Project type `auto` does not have a fixed descriptor. Detect the project type first.');
  }
  const descriptor = PROJECT_TYPES[normalized];
  if (!descriptor) {
    throw new Error(`Unsupported project type: ${projectType}`);
  }
  return descriptor;
}

export async function detectProjectType(projectRoot, explicitProjectType = 'auto') {
  const normalized = normalizeProjectType(explicitProjectType);
  if (normalized !== 'auto') {
    return getProjectTypeDescriptor(normalized);
  }

  const [hasPackageJson, hasPyproject] = await Promise.all([
    exists(path.join(projectRoot, 'package.json')),
    exists(path.join(projectRoot, 'pyproject.toml'))
  ]);

  if (hasPackageJson && !hasPyproject) return getProjectTypeDescriptor('npm');
  if (hasPyproject && !hasPackageJson) return getProjectTypeDescriptor('python-uv');
  if (hasPackageJson && hasPyproject) return getProjectTypeDescriptor('npm');

  throw new Error(`Could not detect a supported project type in ${projectRoot}. Expected package.json for npm projects or pyproject.toml for python-uv projects.`);
}
