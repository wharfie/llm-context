import fs from 'node:fs/promises';
import path from 'node:path';

export async function buildBundleReadme({
  bundleDir,
  archiveFileName = 'LLM_CONTEXT.tar.gz',
  targetKey,
  projectType,
  dependencyArchiveIncluded,
  targetLockIncluded,
  preassembledRepoIncluded,
  preassembledRepoEmbedsDependencies,
  sourceOnly = false
}) {
  const readmeText = projectType.id === 'npm'
    ? buildNpmBundleReadme({
        archiveFileName,
        targetKey,
        dependencyArchiveIncluded,
        targetLockIncluded,
        preassembledRepoIncluded,
        preassembledRepoEmbedsDependencies,
        sourceOnly
      })
    : buildPythonUvBundleReadme({
        archiveFileName,
        targetKey,
        dependencyArchiveIncluded,
        targetLockIncluded,
        preassembledRepoIncluded,
        preassembledRepoEmbedsDependencies,
        sourceOnly
      });

  const readmePath = path.join(bundleDir, 'README.md');
  await fs.writeFile(readmePath, readmeText, 'utf8');
  return readmePath;
}

function buildNpmBundleReadme({ archiveFileName, targetKey, dependencyArchiveIncluded, targetLockIncluded, preassembledRepoIncluded, preassembledRepoEmbedsDependencies, sourceOnly }) {
  const intro = sourceOnly
    ? `This archive contains a byte-faithful source snapshot, an LLM-readable flattened context file, and optional target runtime dependencies for \`${targetKey}\`. It was generated with \`--source-only\`, which keeps the flattened \`LLM_CONTEXT\` view focused on repo source files while runnable dependency state stays in separate bundle artifacts.`
    : `This archive contains a byte-faithful source snapshot, an LLM-readable flattened context file, and optional target runtime dependencies for \`${targetKey}\`.`;

  const targetNodeModulesLine = dependencyArchiveIncluded
    ? `- \`targets/${targetKey}/node_modules.tar.gz\` — canonical target runtime dependencies for \`${targetKey}\`.`
    : `- No \`targets/${targetKey}/node_modules.tar.gz\` is present because this project did not need a \`node_modules/\` tree for the target bundle.`;

  const targetLockLine = targetLockIncluded
    ? `- \`targets/${targetKey}/package-lock.json\` — captured because the target lockfile differs from the source lockfile or the source lockfile is missing.`
    : '- No extra target lockfile was needed.';

  let preassembledRepoLine = '- No preassembled repo archive is present.';
  if (preassembledRepoIncluded && dependencyArchiveIncluded && !preassembledRepoEmbedsDependencies) {
    preassembledRepoLine = '- `repo.tar.gz` — preassembled repo tree without `node_modules/`. The dependency tree stays in `targets/<target>/node_modules.tar.gz` so the bundle does not duplicate large dependency payloads.';
  } else if (preassembledRepoIncluded) {
    preassembledRepoLine = '- `repo.tar.gz` — preassembled fast path containing a ready-to-run `repo/` tree.';
  }

  let fastPathSection = '';
  if (preassembledRepoIncluded && dependencyArchiveIncluded && !preassembledRepoEmbedsDependencies) {
    fastPathSection = `## Fastest manual path

Run these commands exactly from the bundle directory:

\`\`\`bash
tar -xzf ${archiveFileName}
cd LLM_CONTEXT
tar -xzf repo.tar.gz
tar -xzf targets/${targetKey}/node_modules.tar.gz -C repo
cd repo
npm run lint
npm run test
\`\`\`
`;
  } else if (preassembledRepoIncluded) {
    fastPathSection = `## Fastest manual path

Run these commands exactly from the bundle directory:

\`\`\`bash
tar -xzf ${archiveFileName}
cd LLM_CONTEXT
tar -xzf repo.tar.gz
cd repo
npm run lint
npm run test
\`\`\`
`;
  }

  const compatiblePath = `## Compatible reconstruction path

Run these commands exactly from the bundle directory:

\`\`\`bash
tar -xzf ${archiveFileName}
cd LLM_CONTEXT
./assemble.offline.sh
./verify.offline.sh repo
\`\`\``;

  const reconstructionBehavior = `## Reconstruction behavior

- \`assemble.offline.sh\` restores the exact source snapshot into \`./repo\` by default.
- \`assemble.offline.sh\` stages reconstruction in a temporary directory and only swaps the final repo into place after every extraction step succeeds.
- When \`repo.tar.gz\` is present, \`assemble.offline.sh\` prefers it automatically.
- When the bundle also contains \`targets/${targetKey}/node_modules.tar.gz\`, the assembler overlays that dependency archive on top of the preassembled repo unless \`repo.tar.gz\` already embeds \`node_modules/\`.
- If a target \`package-lock.json\` is present and the source lockfile is missing, the assembler copies it into the reconstructed repo.
- If a target \`package-lock.json\` differs from the source lockfile, the assembler preserves the source lockfile and stages the target lockfile at \`repo/.llm_context_target/package-lock.json\`.
- If the bundle omits \`node_modules.tar.gz\`, the assembler skips dependency extraction and still reconstructs the repo cleanly.`;

  const failureRecoverySection = `## Failure recovery

- If \`tar -xzf ${archiveFileName}\` or \`./assemble.offline.sh\` is interrupted, timed out, or killed, treat the current \`repo/\` as invalid partial output.
- Partial extraction can leave empty or missing files under \`node_modules/.bin\` that look like packaging defects even when the archive is correct.
- Delete \`repo/\` and rerun assembly from scratch before diagnosing missing launchers or broken dependencies.
- Only treat missing \`node_modules/.bin\` entries as a real bundle issue after \`./assemble.offline.sh\` exits successfully from a clean bundle directory.`;

  const notes = [
    sourceOnly
      ? '- This bundle was generated with `--source-only`. For npm projects that omits the direct dependency summary from the flattened `LLM_CONTEXT` file, but target `node_modules/` and lockfile capture stay enabled so offline validation still works.'
      : null,
    '- The target dependency tarball is created with platform `tar`, not a JS tar writer, so symlinks and launcher shims under `node_modules/.bin` survive extraction.',
    '- When the CLI writes a bundled `node_modules.tar.gz`, it extracts that archive into a temporary directory and verifies the full extracted `node_modules/` tree against the installed target tree before the bundle is finalized.',
    '- By default, `repo.tar.gz` does not duplicate a separate bundled `node_modules/` tree. That keeps dependency-heavy bundles much smaller while preserving a convenient repo restore archive.',
    sourceOnly
      ? '- For npm bundles created with `--source-only`, the flattened `LLM_CONTEXT` view omits raw lockfiles, raw `node_modules/` contents, and the direct dependency summary.'
      : '- For npm bundles, the flattened `LLM_CONTEXT` view intentionally omits raw lockfiles and raw `node_modules/` contents; it replaces that noise with a smaller direct dependency summary plus selected README and TypeScript entrypoint snippets when available.',
    '- `verify.offline.sh` only runs standard npm scripts that actually exist. It will run `lint`, `typecheck`, and `test` when present. For Jest-style test scripts, it retries with `--runInBand` after an initial failure, which helps in constrained sandboxes.',
    '- `verify.offline.sh repo` resolves the repo path before it starts writing logs, so relative paths work as written.',
    '- On macOS hosts, bundle creation strips more metadata before archiving, which reduces noisy `LIBARCHIVE.xattr...` warnings during extraction on Linux.'
  ].filter(Boolean).join('\n');

  return `# LLM_CONTEXT bundle

${intro}

## Contents

- LLM_CONTEXT — curated flattened text context for LLM consumption
- LLM_CONTEXT_source.tar.gz — exact source snapshot to reconstruct the repo
${preassembledRepoLine}
${targetNodeModulesLine}
${targetLockLine}
- MANIFEST.json — hashes and bundle metadata
- assemble.offline.sh — executable reconstruction script
- verify.offline.sh — executable verifier for lint/typecheck/test style workflows

${fastPathSection}${compatiblePath}

${reconstructionBehavior}

${failureRecoverySection}

## Notes

${notes}
`;
}

function buildPythonUvBundleReadme({ archiveFileName, targetKey, dependencyArchiveIncluded, targetLockIncluded, preassembledRepoIncluded, preassembledRepoEmbedsDependencies, sourceOnly }) {
  const intro = sourceOnly
    ? `This archive contains a byte-faithful source snapshot, an LLM-readable flattened context file, and a target Python virtual environment for \`${targetKey}\`. It was generated with \`--source-only\`, which keeps the prompt-context artifact source-focused while still preserving runnable dependency state for offline validation.`
    : `This archive contains a byte-faithful source snapshot, an LLM-readable flattened context file, and a target Python virtual environment for \`${targetKey}\`.`;

  const targetVenvLine = dependencyArchiveIncluded
    ? `- \`targets/${targetKey}/venv.tar.gz\` — canonical target virtual environment for \`${targetKey}\`, extracted into \`.venv/\`.`
    : `- No \`targets/${targetKey}/venv.tar.gz\` is present.`;

  const targetLockLine = targetLockIncluded
    ? `- \`targets/${targetKey}/uv.lock\` — captured because the target lockfile differs from the source lockfile or the source lockfile is missing.`
    : '- No extra target lockfile was needed.';

  let preassembledRepoLine = '- No preassembled repo archive is present.';
  if (preassembledRepoIncluded && dependencyArchiveIncluded && !preassembledRepoEmbedsDependencies) {
    preassembledRepoLine = '- `repo.tar.gz` — preassembled repo tree without `.venv/`. The virtual environment stays in `targets/<target>/venv.tar.gz` so the bundle does not duplicate large dependency payloads.';
  } else if (preassembledRepoIncluded) {
    preassembledRepoLine = '- `repo.tar.gz` — preassembled fast path containing a ready-to-run `repo/` tree.';
  }

  let fastPathSection = '';
  if (preassembledRepoIncluded && dependencyArchiveIncluded && !preassembledRepoEmbedsDependencies) {
    fastPathSection = `## Fastest manual path

Run these commands exactly from the bundle directory:

\`\`\`bash
tar -xzf ${archiveFileName}
cd LLM_CONTEXT
tar -xzf repo.tar.gz
tar -xzf targets/${targetKey}/venv.tar.gz -C repo
cd repo
../verify.offline.sh .
\`\`\`
`;
  } else if (preassembledRepoIncluded) {
    fastPathSection = `## Fastest manual path

Run these commands exactly from the bundle directory:

\`\`\`bash
tar -xzf ${archiveFileName}
cd LLM_CONTEXT
tar -xzf repo.tar.gz
cd repo
../verify.offline.sh .
\`\`\`
`;
  }

  const compatiblePath = `## Compatible reconstruction path

Run these commands exactly from the bundle directory:

\`\`\`bash
tar -xzf ${archiveFileName}
cd LLM_CONTEXT
./assemble.offline.sh
./verify.offline.sh repo
\`\`\``;

  const reconstructionBehavior = `## Reconstruction behavior

- \`assemble.offline.sh\` restores the exact source snapshot into \`./repo\` by default.
- \`assemble.offline.sh\` stages reconstruction in a temporary directory and only swaps the final repo into place after every extraction step succeeds.
- When \`repo.tar.gz\` is present, \`assemble.offline.sh\` prefers it automatically.
- When the bundle also contains \`targets/${targetKey}/venv.tar.gz\`, the assembler overlays that virtual environment archive on top of the preassembled repo unless \`repo.tar.gz\` already embeds \`.venv/\`.
- If a target \`uv.lock\` is present and the source lockfile is missing, the assembler copies it into the reconstructed repo.
- If a target \`uv.lock\` differs from the source lockfile, the assembler preserves the source copy and stages the target copy at \`repo/.llm_context_target/uv.lock\`.`;

  const failureRecoverySection = `## Failure recovery

- If \`tar -xzf ${archiveFileName}\` or \`./assemble.offline.sh\` is interrupted, timed out, or killed, treat the current \`repo/\` as invalid partial output.
- Partial extraction can leave incomplete \`.venv/\` contents that look like packaging defects even when the archive is correct.
- Delete \`repo/\` and rerun assembly from scratch before diagnosing missing virtual-environment files or broken console scripts.
- Only treat missing \`.venv/\` entries as a real bundle issue after \`./assemble.offline.sh\` exits successfully from a clean bundle directory.`;

  const notes = [
    sourceOnly
      ? '- This bundle was generated with `--source-only`. That flag does not disable `.venv/` or `uv.lock` capture; it only keeps the prompt-context artifact focused on repository source material.'
      : null,
    '- The target virtual environment tarball is created with platform `tar`, not a JS tar writer, so symlinks and installed package files survive extraction.',
    '- Bundled Python console scripts are rewritten to use `#!/usr/bin/env python3`, which keeps them runnable after extraction when `.venv/bin` is on `PATH`.',
    '- `verify.offline.sh` prepends `repo/.venv/bin` to `PATH` and uses `.venv/bin/python -m ...` commands, which avoids stale absolute shebangs after relocation.',
    '- For python-uv bundles, the target virtual environment is created from `pyproject.toml` and `uv.lock` with `uv sync --all-groups --no-install-project`, so dependency groups such as `black`, `flake8`, and `pytest` stay available offline when the project declares them.',
    '- The bundled virtual environment still expects a compatible system `python3` on the target host, just like npm bundles still expect `node` and `npm` to be available for verification.'
  ].filter(Boolean).join('\n');

  return `# LLM_CONTEXT bundle

${intro}

## Contents

- LLM_CONTEXT — curated flattened text context for LLM consumption
- LLM_CONTEXT_source.tar.gz — exact source snapshot to reconstruct the repo
${preassembledRepoLine}
${targetVenvLine}
${targetLockLine}
- MANIFEST.json — hashes and bundle metadata
- assemble.offline.sh — executable reconstruction script
- verify.offline.sh — executable verifier for lint/typecheck/test style workflows

${fastPathSection}${compatiblePath}

${reconstructionBehavior}

${failureRecoverySection}

## Notes

${notes}
`;
}
