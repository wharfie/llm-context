# llm-context-cli

Build a single `LLM_CONTEXT-<folder-name>.tar.gz` from the root of an npm project or a Python project managed with uv.

The unified archive contains:

- `LLM_CONTEXT` — curated flattened text context for an LLM prompt window
- `LLM_CONTEXT_source.tar.gz` — exact source snapshot for byte-faithful reconstruction
- `repo.tar.gz` — preassembled fast path containing a ready-to-run `repo/` tree
- `targets/<platform>-<arch>/node_modules.tar.gz` for npm projects when the target install produces `node_modules/`
- `targets/<platform>-<arch>/venv.tar.gz` for python-uv projects, extracted into `.venv/`
- `targets/<platform>-<arch>/package-lock.json` or `targets/<platform>-<arch>/uv.lock` when the target lockfile differs from the source lockfile or the source lockfile is missing
- `README.md`
- `MANIFEST.json`
- `assemble.offline.sh`
- `verify.offline.sh`

## Install

```bash
npm install -g llm-context-cli
```

Or install a local tarball:

```bash
npm install -g ./llm-context-cli-<version>.tgz
```

## Usage

The CLI auto-detects the project type:

- `package.json` → npm
- `pyproject.toml` → python-uv

Basic usage from the project root:

```bash
llm-context
```

Useful options:

```bash
llm-context --output ./dist/LLM_CONTEXT-my-app.tar.gz
llm-context --project-type npm
llm-context --project-type python-uv
llm-context --target linux-x64
llm-context --platform linux --arch arm64
llm-context --keep-temp
llm-context --source-only
llm-context --docker-image node:22-bookworm-slim
llm-context --embed-dependencies-in-repo
llm-context --no-preassembled-repo
```

## Behavior

- Defaults the output archive name to `LLM_CONTEXT-<current-folder-name>.tar.gz`
- Defaults to target `linux/x64`
- Auto-detects npm vs python-uv from the project root
- Uses Docker when the host cannot natively build the requested target
- `--source-only` skips target dependency capture entirely, so the bundle only contains source artifacts and does not require Docker for cross-target source-only runs
- Cross-target python-uv builds auto-select an Astral uv image from `requires-python` in `uv.lock` or `pyproject.toml`, then pull it when needed
- Keeps the existing npm flow for `node_modules/` and `package-lock.json`
- For python-uv projects, creates a target `.venv/` bundle with `uv sync --all-groups --no-install-project`
- Rewrites bundled Python console-script shebangs to `#!/usr/bin/env python3` so extracted `.venv` environments stay runnable when `.venv/bin` is on `PATH`
- Generates executable `assemble.offline.sh` and `verify.offline.sh` helper scripts inside the bundle
- Resolves relative verification targets correctly, so the documented `./verify.offline.sh repo` flow works as written when bundled dependencies are present or restored separately

### Docker notes

- npm projects default to `node:22-bookworm-slim` for cross-target installs
- python-uv projects work natively on matching hosts
- cross-target python-uv builds auto-select and pull `ghcr.io/astral-sh/uv:python<major.minor>-...` from `requires-python`; `--docker-image` still overrides the automatic choice
- If Docker is installed but its daemon is unavailable, the CLI now raises an explicit error that points to `--source-only` as the no-dependencies fallback

## Context vs runtime state

The CLI now treats prompt context and runnable sandbox state as separate artifacts.

- `LLM_CONTEXT` is optimized for an LLM context window. For npm projects it omits raw lockfiles and raw `node_modules/` content, then replaces that noise with a direct dependency summary plus selected README and TypeScript entrypoint snippets when they are available.
- `LLM_CONTEXT_source.tar.gz`, `repo.tar.gz`, and `targets/<platform>-<arch>/...` preserve the exact source tree and target dependency state needed to run lint, tests, and other project tooling offline.

## Source-only bundles

Use `--source-only` when you want the flattened context, exact source snapshot, and optional preassembled `repo/` tree without any bundled `node_modules/`, `.venv/`, or target lockfile capture.

```bash
llm-context --source-only
```

That mode still writes `README.md`, `MANIFEST.json`, `assemble.offline.sh`, and `verify.offline.sh`, but the generated bundle docs and assembler output stop suggesting immediate verification because dependencies were intentionally omitted.

## Reconstruction

Fastest path from a generated npm bundle:

```bash
tar -xzf LLM_CONTEXT-<folder-name>.tar.gz
cd LLM_CONTEXT
tar -xzf repo.tar.gz
cd repo
npm run lint
npm run test
```

Fastest path from a generated python-uv bundle:

```bash
tar -xzf LLM_CONTEXT-<folder-name>.tar.gz
cd LLM_CONTEXT
tar -xzf repo.tar.gz
tar -xzf targets/linux-x64/venv.tar.gz -C repo
cd repo
../verify.offline.sh .
```

Compatible path that preserves the older workflow for either project type:

```bash
tar -xzf LLM_CONTEXT-<folder-name>.tar.gz
cd LLM_CONTEXT
./assemble.offline.sh
./verify.offline.sh repo
```

`assemble.offline.sh` prefers `repo.tar.gz` when it exists. That means the documented command sequence still works, but it no longer has to replay source extraction and dependency extraction separately.

It also handles target lockfiles:

- if the source snapshot had no lockfile, it copies the target lockfile into the reconstructed repo
- if the target lockfile differs from the source lockfile, it preserves the source copy and stages the target copy at `repo/.llm_context_target/<lockfile>`

When the bundle omits a separate dependency archive, `assemble.offline.sh` still reconstructs the repo cleanly and simply skips that extraction step.
