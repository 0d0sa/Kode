# Kode

A local coding agent (TypeScript CLI). 

> Status: **Phase 0 (scaffolding)**. See `docs/implementation-plan.md` for the full plan and `docs/Phase0.md` for the current phase.

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
```

## Configuration

Kode reads `kode.jsonc` from the current directory upward, falling back to
`~/.kode/kode.jsonc`. See `docs/examples/kode.jsonc` for a sample. API keys are
never stored in config; set them in `.env` / `.env.local` and reference by name
via `model.apiKeyEnv`.