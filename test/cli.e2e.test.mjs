import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.mjs';
import { copyProject, exists, rmrf, runCommand } from '../src/fs-utils.mjs';
import { extractTarGz } from '../src/tar.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(__dirname, 'fixtures');
let tempRoot;

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-context-cli-test-'));
});

after(async () => {
  if (tempRoot) await rmrf(tempRoot);
});

test('builds a unified archive with exact source snapshot and working target node_modules tar', async () => {
  const projectRoot = path.join(tempRoot, 'project-a');
  await copyProject(path.join(fixturesRoot, 'local-dep-project'), projectRoot);

  const outputFile = path.join(projectRoot, 'out.tar.gz');
  await main(['--project-root', projectRoot, '--output', outputFile]);

  const { bundleRoot, assembleScript, verifyScript } = await extractBundle(outputFile, 'inspect-a');

  assert.equal(await exists(path.join(bundleRoot, 'LLM_CONTEXT')), true);
  assert.equal(await exists(path.join(bundleRoot, 'LLM_CONTEXT_source.tar.gz')), true);
  assert.equal(await exists(path.join(bundleRoot, 'targets', 'linux-x64', 'node_modules.tar.gz')), true);
  assert.equal(await exists(path.join(bundleRoot, 'targets', 'linux-x64', 'package-lock.json')), false);
  assert.equal(await exists(assembleScript), true);
  assert.equal(await exists(verifyScript), true);
  await assertExecutable(assembleScript);
  await assertExecutable(verifyScript);

  const manifest = await readJson(path.join(bundleRoot, 'MANIFEST.json'));
  assert.equal(manifest.project.type, 'npm');
  assert.equal(manifest.install.dependencyArchiveIncluded, true);
  assert.equal(manifest.install.dependencyArchivePath, 'targets/linux-x64/node_modules.tar.gz');
  assert.equal(manifest.artifacts.targetDependencies.kind, 'node_modules');

  const sourceRestore = path.join(tempRoot, 'source-restore-a');
  await extractTarGz({ archiveFile: path.join(bundleRoot, 'LLM_CONTEXT_source.tar.gz'), cwd: sourceRestore });
  const originalPackageJson = await fs.readFile(path.join(projectRoot, 'package.json'));
  const restoredPackageJson = await fs.readFile(path.join(sourceRestore, 'package.json'));
  assert.deepEqual(restoredPackageJson, originalPackageJson);

  await extractTarGz({ archiveFile: path.join(bundleRoot, 'targets', 'linux-x64', 'node_modules.tar.gz'), cwd: sourceRestore });
  assert.equal(await exists(path.join(sourceRestore, 'node_modules', '.bin', 'local-hello')), true);
  assert.equal(await exists(path.join(sourceRestore, 'node_modules', 'local-pkg', 'index.js')), true);
});

test('includes target package-lock.json when source lockfile is missing and applies it during assembly', async () => {
  const projectRoot = path.join(tempRoot, 'project-b');
  await copyProject(path.join(fixturesRoot, 'no-lock-project'), projectRoot);

  const outputFile = path.join(projectRoot, 'out.tar.gz');
  await main(['--project-root', projectRoot, '--output', outputFile]);

  const { bundleRoot } = await extractBundle(outputFile, 'inspect-b');
  assert.equal(await exists(path.join(bundleRoot, 'targets', 'linux-x64', 'package-lock.json')), true);

  runCommand(path.join(bundleRoot, 'assemble.offline.sh'), [], { cwd: bundleRoot });
  assert.equal(await exists(path.join(bundleRoot, 'repo', 'package-lock.json')), true);
});

test('builds a source-focused npm bundle and still captures cross-target node_modules via Docker', async () => {
  const projectRoot = path.join(tempRoot, 'project-source-only');
  await copyProject(path.join(fixturesRoot, 'local-dep-project'), projectRoot);

  const fakeDockerDir = path.join(tempRoot, 'fake-docker-source-only');
  const fakeDockerLog = path.join(fakeDockerDir, 'docker.log');
  await createFakeDocker(fakeDockerDir);

  const outputFile = path.join(projectRoot, 'out.tar.gz');
  await withEnvironment({
    PATH: `${fakeDockerDir}:${process.env.PATH || ''}`,
    FAKE_DOCKER_LOG: fakeDockerLog
  }, async () => {
    await main(['--project-root', projectRoot, '--output', outputFile, '--target', 'linux-arm64', '--source-only']);
  });

  const { bundleRoot, assembleScript, verifyScript } = await extractBundle(outputFile, 'inspect-source-only');
  assert.equal(await exists(path.join(bundleRoot, 'targets', 'linux-arm64', 'node_modules.tar.gz')), true);
  assert.equal(await exists(path.join(bundleRoot, 'targets', 'linux-arm64', 'package-lock.json')), false);

  const manifest = await readJson(path.join(bundleRoot, 'MANIFEST.json'));
  assert.equal(manifest.project.type, 'npm');
  assert.equal(manifest.install.required, true);
  assert.equal(manifest.install.dependencyArchiveIncluded, true);
  assert.equal(manifest.install.lockfileIncluded, false);
  assert.equal(manifest.bundleOptions.sourceOnly, true);
  assert.equal(manifest.artifacts.targetDependencies.kind, 'node_modules');
  assert.equal(manifest.artifacts.targetLock, null);

  const bundleReadme = await fs.readFile(path.join(bundleRoot, 'README.md'), 'utf8');
  const contextText = await fs.readFile(path.join(bundleRoot, 'LLM_CONTEXT'), 'utf8');
  assert.match(bundleReadme, /--source-only/);
  assert.match(bundleReadme, /\.\/verify\.offline\.sh repo/);
  assert.match(contextText, /--source-only/);
  assert.doesNotMatch(contextText, /DEPENDENCY CONTEXT/);

  const dockerLogLines = (await fs.readFile(fakeDockerLog, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(dockerLogLines.includes('run node:22-bookworm-slim npm-install'));
  assert.ok(dockerLogLines.includes('run node:22-bookworm-slim tar-create'));

  runCommand(assembleScript, [], { cwd: bundleRoot });
  assert.equal(await exists(path.join(bundleRoot, 'repo', 'node_modules', '.bin', 'local-hello')), true);

  runCommand(verifyScript, ['repo'], { cwd: bundleRoot });
  const verifyResults = await readJson(path.join(bundleRoot, 'repo', '.llm_context_verify', 'results.json'));
  assert.deepEqual(verifyResults, {
    lint: 'skipped',
    test: 'passed'
  });
});

test('builds a curated npm context that omits raw lockfiles and summarizes direct dependency metadata', async () => {
  const projectRoot = path.join(tempRoot, 'project-curated-context');
  await copyProject(path.join(fixturesRoot, 'no-deps-project'), projectRoot);

  const packageJsonPath = path.join(projectRoot, 'package.json');
  const packageJson = await readJson(packageJsonPath);
  packageJson.dependencies = {
    'external-types-pkg': 'file:./packages/external-types-pkg'
  };
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const dependencyDir = path.join(projectRoot, 'packages', 'external-types-pkg');
  await fs.mkdir(dependencyDir, { recursive: true });
  await fs.writeFile(path.join(dependencyDir, 'package.json'), `${JSON.stringify({
    name: 'external-types-pkg',
    version: '1.0.0',
    types: 'index.d.ts',
    main: 'index.js'
  }, null, 2)}\n`);
  await fs.writeFile(path.join(dependencyDir, 'index.d.ts'), 'export interface Greeting {\n  message: string;\n}\n\nexport declare function hello(name: string): Greeting;\n');
  await fs.writeFile(path.join(dependencyDir, 'README.md'), '# external-types-pkg\n\nProvides typed greetings.\n');

  const outputFile = path.join(projectRoot, 'out.tar.gz');
  await main(['--project-root', projectRoot, '--output', outputFile]);

  const { bundleRoot } = await extractBundle(outputFile, 'inspect-curated-context');
  const contextText = await fs.readFile(path.join(bundleRoot, 'LLM_CONTEXT'), 'utf8');

  assert.doesNotMatch(contextText, /FILE: package-lock\.json/);
  assert.match(contextText, /CONTEXT STRATEGY/);
  assert.match(contextText, /DEPENDENCY CONTEXT/);
  assert.match(contextText, /\[dependencies\] external-types-pkg -> file:\.\/packages\/external-types-pkg/);
  assert.match(contextText, /FILE: packages\/external-types-pkg\/index\.d\.ts/);
  assert.match(contextText, /Provides typed greetings\./);
});

test('uses the repo folder name in the default bundle filename and excludes previous bundles from later snapshots', async () => {
  const projectRoot = path.join(tempRoot, 'project-default-output-name');
  await copyProject(path.join(fixturesRoot, 'no-deps-project'), projectRoot);

  await main(['--project-root', projectRoot]);

  const expectedArchive = path.join(projectRoot, 'LLM_CONTEXT-project-default-output-name.tar.gz');
  assert.equal(await exists(expectedArchive), true);

  await main(['--project-root', projectRoot]);

  const { bundleRoot } = await extractBundle(expectedArchive, 'inspect-default-output-name');
  const bundleReadme = await fs.readFile(path.join(bundleRoot, 'README.md'), 'utf8');
  const contextText = await fs.readFile(path.join(bundleRoot, 'LLM_CONTEXT'), 'utf8');
  assert.match(bundleReadme, /tar -xzf LLM_CONTEXT-project-default-output-name\.tar\.gz/);
  assert.doesNotMatch(contextText, /LLM_CONTEXT-project-default-output-name\.tar\.gz/);

  const sourceRestore = path.join(tempRoot, 'source-restore-default-output-name');
  await extractTarGz({ archiveFile: path.join(bundleRoot, 'LLM_CONTEXT_source.tar.gz'), cwd: sourceRestore });
  assert.equal(await exists(path.join(sourceRestore, 'LLM_CONTEXT-project-default-output-name.tar.gz')), false);
});

test('preserves a top-level targets directory from the project source snapshot and assembled repo', async () => {
  const projectRoot = path.join(tempRoot, 'project-targets-dir');
  await copyProject(path.join(fixturesRoot, 'no-deps-project'), projectRoot);

  const targetsFile = path.join(projectRoot, 'targets', 'custom', 'config.json');
  await fs.mkdir(path.dirname(targetsFile), { recursive: true });
  await fs.writeFile(targetsFile, '{\n  "enabled": true\n}\n');

  const outputFile = path.join(projectRoot, 'out.tar.gz');
  await main(['--project-root', projectRoot, '--output', outputFile]);

  const { bundleRoot } = await extractBundle(outputFile, 'inspect-targets-dir');
  const sourceRestore = path.join(tempRoot, 'source-restore-targets-dir');
  await extractTarGz({ archiveFile: path.join(bundleRoot, 'LLM_CONTEXT_source.tar.gz'), cwd: sourceRestore });
  assert.equal(await exists(path.join(sourceRestore, 'targets', 'custom', 'config.json')), true);

  runCommand(path.join(bundleRoot, 'assemble.offline.sh'), [], { cwd: bundleRoot });
  assert.equal(await exists(path.join(bundleRoot, 'repo', 'targets', 'custom', 'config.json')), true);
});

test('rejects invalid and incomplete CLI option values before bundle assembly starts', async () => {
  const projectRoot = path.join(tempRoot, 'project-arg-validation');
  await copyProject(path.join(fixturesRoot, 'no-deps-project'), projectRoot);

  await assert.rejects(
    () => main(['--project-root', projectRoot, '--target', 'linux']),
    /Invalid target: linux/
  );

  await assert.rejects(
    () => main(['--project-root', projectRoot, '--output']),
    /--output requires a value\./
  );

  await assert.rejects(
    () => main(['--project-root']),
    /--project-root requires a value\./
  );
});

test('omits node_modules tar for projects without npm dependencies and still supports the exact offline workflow', async () => {
  const projectRoot = path.join(tempRoot, 'project-c');
  await copyProject(path.join(fixturesRoot, 'no-deps-project'), projectRoot);

  const outputFile = path.join(projectRoot, 'out.tar.gz');
  await main(['--project-root', projectRoot, '--output', outputFile]);

  const { bundleRoot, assembleScript, verifyScript } = await extractBundle(outputFile, 'inspect-c');

  assert.equal(await exists(path.join(bundleRoot, 'targets', 'linux-x64', 'node_modules.tar.gz')), false);
  assert.equal(await exists(assembleScript), true);
  assert.equal(await exists(verifyScript), true);
  await assertExecutable(assembleScript);
  await assertExecutable(verifyScript);

  const manifest = await readJson(path.join(bundleRoot, 'MANIFEST.json'));
  assert.equal(manifest.formatVersion, 6);
  assert.equal(manifest.project.type, 'npm');
  assert.equal(manifest.install.required, false);
  assert.equal(manifest.install.dependencyArchiveIncluded, false);
  assert.equal(manifest.install.dependencyArchivePath, null);
  assert.equal(manifest.install.nodeModulesIncluded, false);
  assert.equal(manifest.artifacts.targetDependencies, null);
  assert.equal(manifest.artifacts.targetNodeModules, null);
  assert.equal(typeof manifest.artifacts.assembleScript.sha256, 'string');
  assert.equal(typeof manifest.artifacts.verifyScript.sha256, 'string');

  runCommand(assembleScript, [], { cwd: bundleRoot });
  const assembledRepo = path.join(bundleRoot, 'repo');
  assert.equal(await exists(path.join(assembledRepo, 'package.json')), true);
  assert.equal(await exists(path.join(assembledRepo, 'node_modules')), false);

  runCommand(verifyScript, ['repo'], { cwd: bundleRoot });
  const verifyResults = await readJson(path.join(assembledRepo, '.llm_context_verify', 'results.json'));
  assert.deepEqual(verifyResults, {
    lint: 'passed',
    test: 'passed'
  });
});

test('raises a docker-daemon-specific error for cross-target npm dependency capture', async () => {
  const projectRoot = path.join(tempRoot, 'project-docker-error');
  await copyProject(path.join(fixturesRoot, 'local-dep-project'), projectRoot);

  const fakeDockerDir = path.join(tempRoot, 'fake-docker-daemon-error');
  await createDockerDaemonUnavailable(fakeDockerDir);

  const outputFile = path.join(projectRoot, 'out.tar.gz');
  await withEnvironment({
    PATH: `${fakeDockerDir}:${process.env.PATH || ''}`
  }, async () => {
    await assert.rejects(
      () => main(['--project-root', projectRoot, '--output', outputFile, '--target', 'linux-arm64']),
      /Docker is required to build the requested target on this host, but the Docker daemon is not reachable\.[\s\S]*Start Docker or choose a target that matches the current host\./
    );
  });
});

test('builds a python-uv bundle with a relocatable venv archive and working offline black/flake8/pytest tooling', async () => {
  const projectRoot = path.join(tempRoot, 'project-d');
  await copyProject(path.join(fixturesRoot, 'python-uv-project'), projectRoot);

  const outputFile = path.join(projectRoot, 'out.tar.gz');
  await main(['--project-root', projectRoot, '--output', outputFile]);

  const { bundleRoot, assembleScript, verifyScript } = await extractBundle(outputFile, 'inspect-d');
  assert.equal(await exists(path.join(bundleRoot, 'targets', 'linux-x64', 'venv.tar.gz')), true);
  assert.equal(await exists(path.join(bundleRoot, 'targets', 'linux-x64', 'uv.lock')), false);
  await assertExecutable(assembleScript);
  await assertExecutable(verifyScript);

  const manifest = await readJson(path.join(bundleRoot, 'MANIFEST.json'));
  assert.equal(manifest.project.type, 'python-uv');
  assert.equal(manifest.install.required, true);
  assert.equal(manifest.install.dependencyArchiveIncluded, true);
  assert.equal(manifest.install.dependencyArchivePath, 'targets/linux-x64/venv.tar.gz');
  assert.equal(manifest.install.lockfileIncluded, false);
  assert.equal(manifest.install.nodeModulesIncluded, false);
  assert.equal(manifest.artifacts.targetDependencies.kind, '.venv');
  assert.equal(manifest.artifacts.targetNodeModules, null);

  const sourceRestore = path.join(tempRoot, 'source-restore-d');
  await extractTarGz({ archiveFile: path.join(bundleRoot, 'LLM_CONTEXT_source.tar.gz'), cwd: sourceRestore });
  await extractTarGz({ archiveFile: path.join(bundleRoot, 'targets', 'linux-x64', 'venv.tar.gz'), cwd: sourceRestore });

  const venvBin = path.join(sourceRestore, '.venv', 'bin');
  const entryPointPath = path.join(venvBin, 'local-uv-hello');
  const entryPointText = await fs.readFile(entryPointPath, 'utf8');
  assert.equal(entryPointText.split('\n', 1)[0], '#!/usr/bin/env python3');
  assert.equal(await exists(path.join(venvBin, 'black')), true);
  assert.equal(await exists(path.join(venvBin, 'flake8')), true);
  assert.equal(await exists(path.join(venvBin, 'pytest')), true);

  const toolEnv = {
    PATH: `${venvBin}:${process.env.PATH}`,
    PYTHONPATH: [sourceRestore, path.join(sourceRestore, 'src'), process.env.PYTHONPATH].filter(Boolean).join(':')
  };

  const helloResult = runCommand(entryPointPath, [], {
    cwd: sourceRestore,
    env: toolEnv
  });
  assert.match(helloResult.stdout, /hello from wheel/);

  const blackResult = runCommand(path.join(venvBin, 'black'), ['--version'], {
    cwd: sourceRestore,
    env: toolEnv
  });
  assert.match(blackResult.stdout, /black, 0\.1\.0/);

  const flake8Result = runCommand(path.join(venvBin, 'flake8'), ['--version'], {
    cwd: sourceRestore,
    env: toolEnv
  });
  assert.match(flake8Result.stdout, /0\.1\.0/);

  const pytestResult = runCommand(path.join(venvBin, 'pytest'), [], {
    cwd: sourceRestore,
    env: toolEnv
  });
  assert.match(`${pytestResult.stdout}${pytestResult.stderr}`, /OK/);

  runCommand(assembleScript, [], { cwd: bundleRoot });
  runCommand(verifyScript, ['repo'], { cwd: bundleRoot });
  const verifyResults = await readJson(path.join(bundleRoot, 'repo', '.llm_context_verify', 'results.json'));
  assert.deepEqual(verifyResults, {
    lint: 'passed',
    test: 'passed'
  });
});

test('captures target uv.lock when the source project does not include one', async () => {
  const projectRoot = path.join(tempRoot, 'project-e');
  await copyProject(path.join(fixturesRoot, 'python-uv-project'), projectRoot);
  await fs.rm(path.join(projectRoot, 'uv.lock'));

  const outputFile = path.join(projectRoot, 'out.tar.gz');
  await main(['--project-root', projectRoot, '--output', outputFile]);

  const { bundleRoot } = await extractBundle(outputFile, 'inspect-e');
  assert.equal(await exists(path.join(bundleRoot, 'targets', 'linux-x64', 'uv.lock')), true);

  const manifest = await readJson(path.join(bundleRoot, 'MANIFEST.json'));
  assert.equal(manifest.project.type, 'python-uv');
  assert.equal(manifest.install.lockfileIncluded, true);
  assert.equal(manifest.install.lockfilePath, 'targets/linux-x64/uv.lock');
  assert.equal(manifest.artifacts.targetLock.path, 'targets/linux-x64/uv.lock');

  runCommand(path.join(bundleRoot, 'assemble.offline.sh'), [], { cwd: bundleRoot });
  assert.equal(await exists(path.join(bundleRoot, 'repo', 'uv.lock')), true);
});

test('auto-selects and pulls a python-uv Docker image from uv.lock for cross-target source-only builds', async () => {
  const projectRoot = path.join(tempRoot, 'project-f');
  await copyProject(path.join(fixturesRoot, 'python-uv-project'), projectRoot);

  const fakeDockerDir = path.join(tempRoot, 'fake-docker-f');
  const fakeDockerLog = path.join(fakeDockerDir, 'docker.log');
  await createFakeDocker(fakeDockerDir);

  const outputFile = path.join(projectRoot, 'out.tar.gz');
  await withEnvironment({
    PATH: `${fakeDockerDir}:${process.env.PATH || ''}`,
    FAKE_DOCKER_LOG: fakeDockerLog,
    FAKE_DOCKER_ALLOWED_PULLS: 'ghcr.io/astral-sh/uv:python3.13-bookworm'
  }, async () => {
    await main(['--project-root', projectRoot, '--output', outputFile, '--target', 'linux-arm64', '--source-only']);
  });

  const dockerLogLines = (await fs.readFile(fakeDockerLog, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  assert.deepEqual(
    dockerLogLines.filter((line) => line.startsWith('pull ')),
    [
      'pull ghcr.io/astral-sh/uv:python3.13-bookworm-slim',
      'pull ghcr.io/astral-sh/uv:python3.13-bookworm'
    ]
  );
  assert.ok(dockerLogLines.includes('run ghcr.io/astral-sh/uv:python3.13-bookworm uv-sync'));
  assert.ok(dockerLogLines.includes('run ghcr.io/astral-sh/uv:python3.13-bookworm tar-create'));

  const { bundleRoot } = await extractBundle(outputFile, 'inspect-f');
  assert.equal(await exists(path.join(bundleRoot, 'targets', 'linux-arm64', 'venv.tar.gz')), true);

  const manifest = await readJson(path.join(bundleRoot, 'MANIFEST.json'));
  assert.equal(manifest.bundleOptions.sourceOnly, true);
  assert.equal(manifest.install.dependencyArchiveIncluded, true);
});

async function withEnvironment(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function createFakeDocker(binDir) {
  await fs.mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'docker');
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { execFileSync } = require('node:child_process');",
    "const args = process.argv.slice(2);",
    "const logFile = process.env.FAKE_DOCKER_LOG;",
    "function log(line) { if (logFile) fs.appendFileSync(logFile, `${line}\\n`); }",
    "function pullAllowList() { return new Set(String(process.env.FAKE_DOCKER_ALLOWED_PULLS || '').split(',').filter(Boolean)); }",
    "function localImages() { return new Set(String(process.env.FAKE_DOCKER_LOCAL_IMAGES || '').split(',').filter(Boolean)); }",
    "function workspaceRoot(argv) { const index = argv.indexOf('-v'); if (index === -1) return null; return String(argv[index + 1] || '').split(':')[0]; }",
    "function dockerImage(argv) { const bashIndex = argv.indexOf('bash'); return bashIndex > 0 ? argv[bashIndex - 1] : null; }",
    "function pythonMinorVersion(image) { const match = String(image || '').match(/python(\\d+\\.\\d+)/); return match ? match[1] : '3.12'; }",
    "function createFakeNodeModules(root) {",
    "  const nodeModulesDir = path.join(root, \"node_modules\");",
    "  const binDir = path.join(nodeModulesDir, \".bin\");",
    "  fs.mkdirSync(binDir, { recursive: true });",
    "  fs.symlinkSync(\"../packages/local-pkg\", path.join(nodeModulesDir, \"local-pkg\"), \"dir\");",
    "  fs.symlinkSync(\"../local-pkg/bin/local-hello.js\", path.join(binDir, \"local-hello\"));",
    "}",
    "function createFakeVenv(root, image) {",
    "  const pythonMinor = pythonMinorVersion(image);",
    "  const venvDir = path.join(root, '.venv');",
    "  const binDir = path.join(venvDir, 'bin');",
    "  const sitePackagesDir = path.join(venvDir, 'lib', `python${pythonMinor}`, 'site-packages');",
    "  const packageDir = path.join(sitePackagesDir, 'local_uv_pkg');",
    "  const distInfoDir = path.join(sitePackagesDir, 'local_uv_pkg-0.1.0.dist-info');",
    "  fs.mkdirSync(binDir, { recursive: true });",
    "  fs.mkdirSync(packageDir, { recursive: true });",
    "  fs.mkdirSync(distInfoDir, { recursive: true });",
    "  fs.writeFileSync(path.join(venvDir, 'pyvenv.cfg'), `version = ${pythonMinor}\\n`);",
    "  const pythonShim = ['#!/usr/bin/env bash', `echo fake python ${pythonMinor}`].join('\\n') + '\\n';",
    "  fs.writeFileSync(path.join(binDir, 'python'), pythonShim);",
    "  fs.chmodSync(path.join(binDir, 'python'), 0o755);",
    "  fs.copyFileSync(path.join(binDir, 'python'), path.join(binDir, 'python3'));",
    "  fs.chmodSync(path.join(binDir, 'python3'), 0o755);",
    "  fs.writeFileSync(path.join(binDir, 'local-uv-hello'), `#!${path.join(root, '.venv', 'bin', 'python3')}\\nprint(\\\"hello from fake docker\\\")\\n`);",
    "  fs.chmodSync(path.join(binDir, 'local-uv-hello'), 0o755);",
    "  fs.writeFileSync(path.join(packageDir, '__init__.py'), '__all__ = []\\n');",
    "  fs.writeFileSync(path.join(distInfoDir, 'METADATA'), 'Metadata-Version: 2.1\\nName: local-uv-pkg\\nVersion: 0.1.0\\n');",
    "}",
    "if (args[0] === '--version') { console.log('Docker version 0.0.0-fake'); process.exit(0); }",
    "if (args[0] === 'image' && args[1] === 'inspect') { const image = args[2]; log(`inspect ${image}`); process.exit(localImages().has(image) ? 0 : 1); }",
    "if (args[0] === 'pull') { const image = args[1]; log(`pull ${image}`); const allowed = pullAllowList(); if (allowed.size === 0 || allowed.has(image)) { console.log(`Pulled ${image}`); process.exit(0); } console.error(`manifest unknown: ${image}`); process.exit(1); }",
    "if (args[0] === 'run') {",
    "  const image = dockerImage(args);",
    "  const workspace = workspaceRoot(args);",
    "  const bashIndex = args.indexOf('bash');",
    "  const command = bashIndex === -1 ? '' : String(args[bashIndex + 2] || '');",
    "  if (!workspace || !image) { console.error('missing workspace or image'); process.exit(1); }",
    "  if (/\\bnpm\\b/.test(command)) { createFakeNodeModules(workspace); log(`run ${image} npm-install`); process.exit(0); }",
    "  if (command.includes('uv sync')) { createFakeVenv(workspace, image); log(`run ${image} uv-sync`); process.exit(0); }",
    "  if (command.includes('tar -czf')) {",
    "    const match = command.match(/tar -czf ['\\\"]?([^'\\\" ]+)['\\\"]? -C \\/work ['\\\"]?([^'\\\" ]+)['\\\"]?/);",
    "    if (!match) { console.error(`unsupported tar command: ${command}`); process.exit(1); }",
    "    execFileSync('tar', ['-czf', path.join(workspace, match[1]), '-C', workspace, match[2]], { stdio: 'ignore' });",
    "    log(`run ${image} tar-create`);",
    "    process.exit(0);",
    "  }",
    "  console.error(`unsupported docker run command: ${command}`);",
    "  process.exit(1);",
    "}",
    "console.error(`unsupported docker invocation: ${args.join(' ')}`);",
    "process.exit(1);",
    ''
  ].join('\n');

  await fs.writeFile(scriptPath, script, 'utf8');
  await fs.chmod(scriptPath, 0o755);
}

async function createDockerDaemonUnavailable(binDir) {
  await fs.mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'docker');
  const script = [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('Docker version 0.0.0-fake'); process.exit(0); }",
    "console.error('docker: Cannot connect to the Docker daemon at unix:///tmp/fake-docker.sock. Is the docker daemon running?');",
    "process.exit(125);",
    ''
  ].join('\n');

  await fs.writeFile(scriptPath, script, 'utf8');
  await fs.chmod(scriptPath, 0o755);
}

async function extractBundle(archiveFile, inspectName) {
  const inspectRoot = path.join(tempRoot, inspectName);
  await extractTarGz({ archiveFile, cwd: inspectRoot });
  const bundleRoot = path.join(inspectRoot, 'LLM_CONTEXT');
  return {
    inspectRoot,
    bundleRoot,
    assembleScript: path.join(bundleRoot, 'assemble.offline.sh'),
    verifyScript: path.join(bundleRoot, 'verify.offline.sh')
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function assertExecutable(filePath) {
  const stat = await fs.stat(filePath);
  assert.notEqual(stat.mode & 0o111, 0, `${filePath} should be executable`);
}
