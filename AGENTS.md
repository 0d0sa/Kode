# AGENTS.md

Project conventions for any coding agent (including Kode itself) working in this
repository. Read this before making changes.

## Stack

- Language: TypeScript (ESM-only, Node 20.11+)
- Package manager: **pnpm**
- Build: tsup (ESM + dts). `pnpm build` → `dist/`
- Dev run: `tsx` via `pnpm dev`
- Test/lint/format: vitest, biome (lint only), prettier

## Commands

```bash
pnpm typecheck   # must stay green
pnpm test        # vitest run
pnpm lint        # biome check src
pnpm format:check
pnpm build
```

## Rules

- Do **not** edit anything under `dist/` (build output).
- Keep ESM: use `.js` specifiers for relative imports (`./x.js`), use
  `import type` for type-only imports (`verbatimModuleSyntax` is on).
- Preserve strict checks: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`.
- After edits, run `pnpm typecheck && pnpm test && pnpm lint` before declaring
  done.
- Do not commit `.env`, `.env.local`, `dist/`, or `node_modules/`.
- Config layout authoritative schemas live in `src/config/schema.ts`
  (zod). Don't read config fields ad hoc — extend the schema.
- Logging goes to `~/.kode/logs/` via pino; never log secrets/keys.

## Project layout

- `src/agent/` — agent loop, prompt, context window (planner in later phases)
- `src/llm/` — providers (anthropic + openai-compatible), message conversion, factory
- `src/tools/` — tool registry + implementations (`fs/` read, `edit/` replace, `shell/` run)
- `src/config/` — config schema, discovery, loader, env
- `src/infra/` — logger and other infra
- `src/cli/` — commander entry + commands
- `docs/` — `implementation-plan.md`, `Phase0.md`, `Phase1.md`, examples
- `tests/` — unit tests and fixtures
