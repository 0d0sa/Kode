# Kode

A local coding agent (TypeScript CLI).

> Status: **Phase 3 (token-aware context management)**. Kode supports streaming chat,
> Anthropic/OpenAI-compatible providers, repository search and editing, scoped
> permissions, audit logs, undo, request-level token budgets, deterministic tool
> compaction, and checkpointed history summaries. See `docs/implementation-plan.md`
> and the phase documents in `docs/`.

## Requirements

- Node.js >= 20.11
- pnpm (`npm install -g pnpm` if missing)

## Develop

```bash
pnpm install      # install dependencies
pnpm dev          # run from source via tsx (e.g. `pnpm dev -- --version`)
pnpm build        # produce dist/ via tsup
pnpm start        # run built output
pnpm test         # run unit tests (vitest)
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome check src
pnpm format       # prettier --write .
pnpm format:check # prettier --check .
```

## Quick check

```bash
node dist/index.js --version
node dist/index.js config
node dist/index.js repl
node dist/index.js run "read package.json and summarize it"
node dist/index.js run --debug "inspect the repository"
```

Inside the REPL, `/undo` restores the latest successful file-edit group after
confirmation. `/help`, `/clear`, `/exit`, and `/quit` are also available.

## Repository tools

Kode exposes seven bounded tools to the model:

- `glob` and `grep` discover files and text. They prefer ripgrep and fall back
  to a Node implementation when `rg` is unavailable.
- `read_file` streams UTF-8 text and returns a SHA-256 hash.
- `write_file` creates files or explicitly overwrites a file using that hash.
- `replace_in_file` performs exact, hash-guarded replacements.
- `apply_patch` dry-runs a multi-file unified diff before changing any target.
- `run_command` executes a bounded, cancellable bash command.

File writes use temporary-file rename, optimistic hash checks, and snapshots
under `~/.kode/undo/`. Permission decisions and outcomes are written as
redacted JSONL under `~/.kode/audit/`. Both stores use 30-day lazy retention:
old entries are cleaned when new records are written, and undo additionally keeps
at most 100 edit groups per project.

## Configuration

Kode reads `kode.jsonc` from the current directory upward, falling back to
`~/.kode/kode.jsonc`. See `docs/examples/kode.jsonc` for a sample. Prefer storing
API keys in `.env` / `.env.local` and referencing them via `model.apiKeyEnv`.
Inline `model.apiKey` is supported for compatibility but should not be committed;
`kode config` always redacts it. A `local` provider must set `model.baseURL`.

Permissions can still use `default` and per-tool `overrides`. Phase 2 also
supports ordered `rules` matching `tools`, `paths`, and safe
`commandPrefixes`; the first matching rule wins. Workspace reads are allowed
by default, while writes, commands, and workspace-external access require
confirmation unless an explicit rule decides otherwise. See
`docs/examples/kode.jsonc` for a complete example.

Phase 3 replaces the old hard 20-message cutoff with a complete-request token
budget. `model.maxTokens` remains the output limit. The input limit is the
provider context window minus that output reserve and a safety reserve; compatible
or local models can override the detected window with
`agent.context.windowTokens`. When necessary, Kode first compacts older tool
results, then summarizes completed history while retaining the root/latest user
instructions and recent tool chain verbatim. Raw session history is not rewritten.

Use `--debug` with `kode`, `kode repl`, or `kode run` to print numeric context
budget and compaction diagnostics to stderr. Message bodies, summaries, source
text, and keys are never included in that report.
