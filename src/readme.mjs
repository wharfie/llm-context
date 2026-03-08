import fs from 'node:fs/promises';
import path from 'node:path';

export async function buildBundleReadme({
  bundleDir,
  targetKey,
  projectType,
  dependencyArchiveIncluded,
  targetLockIncluded,
  preassembledRepoIncluded,
  preassembledRepoEmbedsDependencies
}) {
  const readmeText = projectType.id === 'npm'
    ? buildNpmBundleReadme({
        targetKey,
        dependencyArchiveIncluded,
        targetLockIncluded,
        preassembledRepoIncluded,
        preassembledRepoEmbedsDependencies
      })
    : buildPythonUvBundleReadme({
        targetKey,
        dependencyArchiveIncluded,
        targetLockIncluded,
        preassembledRepoIncluded,
        preassembledRepoEmbedsDependencies
      });

  const readmePath = path.join(bundleDir, 'README.md');
  await fs.writeFile(readmePath, readmeText, 'utf8');
  return readmePath;
}

function buildNpmBundleReadme({ targetKey, dependencyArchiveIncluded, targetLockIncluded, preassembledRepoIncluded, preassembledRepoEmbedsDependencies }) {
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
tar -xzf LLM_CONTEXT.tar.gz
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
tar -xzf LLM_CONTEXT.tar.gz
cd LLM_CONTEXT
tar -xzf repo.tar.gz
cd repo
npm run lint
npm run test
\`\`\`
`;
  }

  return `# LLM_CONTEXT bundle

This archive contains a byte-faithful source snapshot, an LLM-readable flattened context file, and optional target runtime dependencies for \`${targetKey}\`.

## Contents

- LLM_CONTEXT — flattened text context for LLM consumption
- LLM_CONTEXT_source.tar.gz — exact source snapshot to reconstruct the repo
${preassembledRepoLine}
${targetNodeModulesLine}
${targetLockLine}
- MANIFEST.json — hashes and bundle metadata
- assemble.offline.sh — executable reconstruction script
- verify.offline.sh — executable verifier for lint/test style workflows

${fastPathSection}## Compatible reconstruction path

Run these commands exactly from the bundle directory:

\`\`\`bash
tar -xzf LLM_CONTEXT.tar.gz
cd LLM_CONTEXT
./assemble.offline.sh
./verify.offline.sh repo
\`\`\`

## Reconstruction behavior

- \`assemble.offline.sh\` restores the exact source snapshot into \`./repo\` by default.
- When \`repo.tar.gz\` is present, \`assemble.offline.sh\` prefers it automatically.
- When the bundle also contains \`targets/${targetKey}/node_modules.tar.gz\`, the assembler overlays that dependency archive on top of the preassembled repo unless \`repo.tar.gz\` already embeds \`node_modules/\`.
- If a target \`package-lock.json\` is present and the source lockfile is missing, the assembler copies it into the reconstructed repo.
- If a target \`package-lock.json\` differs from the source lockfile, the assembler preserves the source lockfile and stages the target lockfile at \`repo/.llm_context_target/package-lock.json\`.
- If the bundle omits \`node_modules.tar.gz\`, the assembler skips dependency extraction and still reconstructs the repo cleanly.

## Notes

- The target dependency tarball is created with platform \`tar\`, not a JS tar writer, so symlinks and launcher shims under \`node_modules/.bin\` survive extraction.
- By default, \`repo.tar.gz\` does not duplicate a separate bundled \`node_modules/\` tree. That keeps dependency-heavy bundles much smaller while preserving a convenient repo restore archive.
- \`verify.offline.sh\` only runs npm scripts that actually exist. For Jest-style test scripts, it retries with \`--runInBand\` after an initial failure, which helps in constrained sandboxes.
- \`verify.offline.sh repo\` resolves the repo path before it starts writing logs, so relative paths work as written.
- On macOS hosts, bundle creation strips more metadata before archiving, which reduces noisy \`LIBARCHIVE.xattr...\` warnings during extraction on Linux.
`;
}

function buildPythonUvBundleReadme({ targetKey, dependencyArchiveIncluded, targetLockIncluded, preassembledRepoIncluded, preassembledRepoEmbedsDependencies }) {
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
tar -xzf LLM_CONTEXT.tar.gz
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
tar -xzf LLM_CONTEXT.tar.gz
cd LLM_CONTEXT
tar -xzf repo.tar.gz
cd repo
../verify.offline.sh .
\`\`\`
`;
  }

  return `# LLM_CONTEXT bundle

This archive contains a byte-faithful source snapshot, an LLM-readable flattened context file, and a target Python virtual environment for \`${targetKey}\`.

## Contents

- LLM_CONTEXT — flattened text context for LLM consumption
- LLM_CONTEXT_source.tar.gz — exact source snapshot to reconstruct the repo
${preassembledRepoLine}
${targetVenvLine}
${targetLockLine}
- MANIFEST.json — hashes and bundle metadata
- assemble.offline.sh — executable reconstruction script
- verify.offline.sh — executable verifier for lint/test style workflows

${fastPathSection}## Compatible reconstruction path

Run these commands exactly from the bundle directory:

\`\`\`bash
tar -xzf LLM_CONTEXT.tar.gz
cd LLM_CONTEXT
./assemble.offline.sh
./verify.offline.sh repo
\`\`\`

## Reconstruction behavior

- \`assemble.offline.sh\` restores the exact source snapshot into \`./repo\` by default.
- When \`repo.tar.gz\` is present, \`assemble.offline.sh\` prefers it automatically.
- When the bundle also contains \`targets/${targetKey}/venv.tar.gz\`, the assembler overlays that virtual environment archive on top of the preassembled repo unless \`repo.tar.gz\` already embeds \`.venv/\`.
- If a target \`uv.lock\` is present and the source lockfile is missing, the assembler copies it into the reconstructed repo.
- If a target \`uv.lock\` differs from the source lockfile, the assembler preserves the source copy and stages the target copy at \`repo/.llm_context_target/uv.lock\`.

## Notes

- The target virtual environment tarball is created with platform \`tar\`, not a JS tar writer, so symlinks and installed package files survive extraction.
- Bundled Python console scripts are rewritten to use \`/usr/bin/env python3\`, which keeps them runnable after extraction when \`.venv/bin\` is on \`PATH\`.
- \`verify.offline.sh\` prepends \`repo/.venv/bin\` to \`PATH\` and uses \`.venv/bin/python -m ...\` commands, which avoids stale absolute shebangs after relocation.
- The bundled virtual environment still expects a compatible system \`python3\` on the target host, just like npm bundles still expect \`node\` and \`npm\` to be available for verification.
`;
}
