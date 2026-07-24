# Phase 0 执行方案：脚手架（Scaffolding）

> 对应 `implementation-plan.md` §7 Phase 0。本文是该阶段可落地的执行手册：选型、任务、文件内容、验收。

## 0. 阶段定位

让 `kode` 可构建、可运行、可读配置、可写日志。**此阶段不接 LLM、不跑 agent、不实现任何工具**——只把地基和骨架立起来，让 Phase 1 能直接往上长。

**MVP 关系**：Phase 0 是 MVP（Phase 1–3 合并体）的前置地基。

## 1. 设计选型确认（决策汇总）

以下决策来自交互确认，作为本阶段不可推翻的输入：

| 维度 | 决策 | 说明 |
|---|---|---|
| 运行时 | Node ≥ 20.11 | ESM 原生支持稳定；`engines` 锁版本 |
| 模块系统 | **ESM-only** | `"type": "module"`；`module: NodeNext` |
| 包管理 | **pnpm** | lockfile、scripts、未来 workspace |
| 构建 | tsup（esbuild） | 输出 ESM + dts + sourcemap |
| CLI 框架 | **commander** | Phase 0 仅 `--version/--help/config`；Phase 6 上 Ink 不冲突 |
| 配置校验 | zod | schema 单一来源、错误友好 |
| JSONC 解析 | jsonc-parser | 注释 + 末尾逗号 |
| env 加载 | **dotenv**（程序化） | 叠加 `.env.local` + `.env` |
| 配置查找 | **cwd 向上逐级 + home 兜底** | 项目级 `kode.jsonc`；全局 `~/.kode/kode.jsonc` |
| 日志 | pino | 落 `~/.kode/logs/kode-YYYY-MM-DD.log` |
| 测试 | vitest | 单测先开 |
| Lint | biome（仅 lint） | formatter 关闭，避免与 prettier 冲突 |
| 格式化 | prettier | 格式化 source of truth |
| 开发运行 | tsx | 免构建跑源码 |

**与主计划差异**：项目配置文件名定为 `kode.jsonc`（原计划写作 `opencode.jsonc`）；全局默认位于 `~/.kode/kode.jsonc`。后续将同步更新 `implementation-plan.md`。

## 2. 范围

### 2.1 必做（in-scope）
- pnpm 工程初始化、tsconfig（ESM/NodeNext/strict）、tsup 构建链
- `kode` 命令：`--version` / `--help` / `config` 子命令
- 配置加载：`kode.jsonc` 查找 + jsonc 解析 + zod 校验 + 错误友好
- env 加载（dotenv）+ 模型密钥引用校验（不崩溃，仅警告）
- pino 日志落 `~/.kode/logs/`，级别可通过 `KODE_LOG_LEVEL` 调
- vitest + biome + prettier 工具链就位，至少 1 个配置 loader 单测通过
- `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿

### 2.2 不做（out-of-scope，留给后续阶段）
- LLM provider、agent loop、任何工具（Phase 1）
- `repl` 实际逻辑（Phase 0 仅留 `repl` 子命令 stub，提示 Coming in Phase 1）
- 权限门、上下文管理、会话存储
- `.kode/undo/`、与 git 交互（Phase 2）
- 单可执行二进制发布（Phase 7）
- 配置嵌套深度合并（Phase 0 仅浅层 per-key 覆盖，见 §6.2）

### 2.3 可选附加
- `AGENTS.md` 骨架：本项目将由 coding agent 协作开发，提前放一份项目约定文件，便于任何 agent（包括未来的 Kode 本身）读取。**建议做**，但非验收阻断项。

## 3. 任务拆解（WBS）

| ID | 任务 | 依赖 | 产出 | 估时 |
|----|------|------|------|------|
| T01 | pnpm 工程初始化、`package.json` 元数据/scripts/`engines` | — | package.json | 0.5h |
| T02 | tsconfig（ESM/NodeNext/strict） | T01 | tsconfig.json | 0.5h |
| T03 | tsup 构建配置（ESM + dts + sourcemap） | T02 | tsup.config.ts | 0.5h |
| T04 | 安装依赖（runtime + dev） | T01 | pnpm-lock | 0.5h |
| T05 | `src/version.ts` 版本读取（createRequire） | T01 | src/version.ts | 0.5h |
| T06 | 配置 schema（zod） | T04 | src/config/schema.ts | 1h |
| T07 | 配置查找算法 | T06 | src/config/find.ts | 1h |
| T08 | JSONC 读取 + 校验 + 浅层合并 loader | T06 | src/config/loader.ts、errors.ts | 1.5h |
| T09 | env 加载（dotenv）+ 密钥引用校验 | T06 | src/config/env.ts | 0.5h |
| T10 | pino logger（homedir 目录、日期文件） | T04 | src/infra/logger.ts | 0.5h |
| T11 | CLI（commander）入口与子命令 | T05,T06 | src/cli/index.ts、commands/config.ts | 1.5h |
| T12 | bin shim + package.json bin 映射 + pnpm 自链 | T11 | bin/kode.js | 0.5h |
| T13 | `repl` stub 子命令 | T11 | src/cli/commands/repl.ts | 0.25h |
| T14 | vitest 配置 + 配置 loader 单测 | T06,T08 | vitest.config.ts、tests/unit/config.test.ts | 2h |
| T15 | biome + prettier 配置 + scripts | T01 | biome.json、.prettierrc | 0.5h |
| T16 | .gitignore 更新（dist/node_modules/.env*） + README/AGENTS 增补 | T01 | 文件更新 | 0.75h |
| T17 | 验收走查（§8 全部用例） | 全部 | 验收记录 | 1h |

**合计 ≈ 12.5–13h ≈ 2 个工作日**（与主计划预估 ~2 天一致）。

关键路径：T01 → T02/T04 → T06 → T08 → T11 → T12 → T17。T07/T09/T10 可并行。

## 4. 工程目录（Phase 0 结束时的产物树）

```
Kode/
├── package.json            # 编辑：元数据/scripts/bin/engines
├── tsconfig.json
├── tsup.config.ts
├── biome.json
├── .prettierrc
├── vitest.config.ts
├── .gitignore              # 编辑：补 dist/node_modules/.env*
├── README.md               # 编辑：补安装/开发命令（极简）
├── AGENTS.md               # 可选：项目约定
├── bin/
│   └── kode.js             # ESM shebang 入口
├── src/
│   ├── index.ts            # 引导：loadEnv → program.parseAsync
│   ├── version.ts
│   ├── cli/
│   │   ├── index.ts
│   │   └── commands/
│   │       ├── config.ts
│   │       └── repl.ts     # stub
│   ├── config/
│   │   ├── schema.ts
│   │   ├── find.ts
│   │   ├── loader.ts
│   │   ├── env.ts
│   │   └── errors.ts
│   └── infra/
│       └── logger.ts
├── tests/
│   ├── unit/
│   │   └── config.test.ts
│   └── fixtures/
│       └── configs/
│           ├── valid.jsonc
│           └── invalid.jsonc
└── docs/
    ├── implementation-plan.md
    ├── Phase0.md
    └── examples/
        └── kode.jsonc      # 示例（不放仓库根，避免干扰发现逻辑）
```

## 5. 关键文件内容（可直接落地）

### 5.1 `package.json`（增量字段）
```json
{
  "name": "kode",
  "version": "0.0.1",
  "type": "module",
  "engines": { "node": ">=20.11" },
  "bin": { "kode": "bin/kode.js" },
  "main": "dist/index.js",
  "exports": { ".": "./dist/index.js" },
  "files": ["dist", "bin", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check src",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "dependencies": {
    "commander": "^12.0.0",
    "zod": "^3.23.0",
    "dotenv": "^16.4.0",
    "pino": "^9.0.0",
    "jsonc-parser": "^3.3.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "tsup": "^8.0.0",
    "tsx": "^4.7.0",
    "@types/node": "^20.12.0",
    "vitest": "^1.6.0",
    "@biomejs/biome": "^1.9.0",
    "prettier": "^3.3.0"
  }
}
```

### 5.2 `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```
> `tests` 排除进单独 `tsconfig.test.json`，`vitest` 自行编译；Phase 0 先共用上方主配置即可，测试由 vitest 处理。

### 5.3 `tsup.config.ts`
```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20.11',
  platform: 'node',
});
```
> 版本不用 `define` 注入——见 §6.1 改用运行时读取，避免 dev(tsx) 与 built 行为分裂。

### 5.4 `src/version.ts`
```ts
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

export const VERSION: string = pkg.version;
```

### 5.5 `src/config/schema.ts`
```ts
import { z } from 'zod';

export const ModelProviderSchema = z.enum(['anthropic', 'openai', 'local']);

export const ModelConfigSchema = z.object({
  provider: ModelProviderSchema,
  model: z.string().min(1),
  apiKeyEnv: z.string().optional(),
  baseURL: z.string().url().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const PermissionDecisionSchema = z.enum(['allow', 'confirm', 'deny']);

export const PermissionsSchema = z.object({
  default: PermissionDecisionSchema.optional(),
  overrides: z.record(z.string(), PermissionDecisionSchema).optional(),
});

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  model: ModelConfigSchema.optional(),
  permissions: PermissionsSchema.optional(),
  rules: z.array(z.string()).optional(),
  includeCoAuthoredBy: z.boolean().optional(),
  logLevel: z.enum(['fatal','error','warn','info','debug','trace','silent']).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
```
> Phase 0 只定义结构、预留字段；`model` 为可选，无 LLM 调用时不会被消费。schema 版本号 `version: 1` 锁住演进入口（见 §6.6）。

### 5.6 `src/config/find.ts`
```ts
import { existsSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

export const CONFIG_FILENAME = 'kode.jsonc';
export const HOME_CONFIG_PATH = () => join(homedir(), '.kode', 'kode.jsonc');

export function findConfigFiles(cwd: string): string[] {
  const found: string[] = [];
  let dir = isAbsolute(cwd) ? cwd : join(process.cwd(), cwd);
  while (true) {
    const p = join(dir, CONFIG_FILENAME);
    if (existsSync(p)) found.push(p);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = HOME_CONFIG_PATH();
  if (existsSync(home)) found.push(home);
  return found;
}
```
> 顺序：最近(最内层) → … → 最外层 → home；调用方按“远者先、近者后”叠加（见 §5.8）。

### 5.7 `src/config/errors.ts`
```ts
export class ConfigError extends Error {
  constructor(message: string, public readonly files: string[] = []) {
    super(message);
    this.name = 'ConfigError';
  }
}
```

### 5.8 `src/config/loader.ts`
```ts
import { readFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { ConfigSchema, type Config } from './schema.js';
import { ConfigError } from './errors.js';

type ParseError = { error: number; offset: number; length: number };

function readJsonc(file: string): Record<string, unknown> {
  const text = readFileSync(file, 'utf8');
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new ConfigError(
      `${file}: ${errors.length} JSONC parse error(s) (first code ${errors[0]?.error})`,
      [file],
    );
  }
  return (value ?? {}) as Record<string, unknown>;
}

export interface LoadResult {
  config: Config;
  files: string[];
}

export function loadConfig(files: string[]): LoadResult {
  if (files.length === 0) {
    const parsed = ConfigSchema.safeParse({});
    if (!parsed.success) throw new ConfigError('Default config failed to parse', []);
    return { config: parsed.data, files: [] };
  }
  // 远者先（home 在末尾，reverse 后成基底），近者后（覆盖）
  const ordered = [...files].reverse();
  let merged: Record<string, unknown> = {};
  for (const f of ordered) {
    const raw = readJsonc(f);
    merged = { ...merged, ...raw }; // 浅层 per-key 覆盖（§6.2）
  }
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Config validation failed: ${detail}`, files);
  }
  return { config: parsed.data, files };
}
```

### 5.9 `src/config/env.ts`
```ts
import { config as dotenvConfig } from 'dotenv';
import { logger } from '../infra/logger.js';

export function loadEnv(cwd: string): void {
  dotenvConfig({ path: [`${cwd}/.env.local`, `${cwd}/.env`] });
}

export function assertApiKey(envName: string | undefined): boolean {
  if (!envName) return true; // 未配置 apiKeyEnv，跳过校验
  const present = Boolean(process.env[envName]);
  if (!present) {
    logger.warn({ envName }, 'Referenced API key env var is not set');
  }
  return present;
}
```

### 5.10 `src/infra/logger.ts`
```ts
import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../version.js';

const logDir = join(homedir(), '.kode', 'logs');
mkdirSync(logDir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 10);
const dest = pino.destination(join(logDir, `kode-${stamp}.log`));

export const logger = pino(
  {
    level: process.env.KODE_LOG_LEVEL ?? 'info',
    base: { version: VERSION },
  },
  dest,
);

export const childLogger = (component: string) => logger.child({ component });
```
> 轮转策略：Phase 0 每日单文件、不删旧；保留/轮转留 Phase 7。进程退出时 pino 默认 flush 同步，CLI 短进程足够。

### 5.11 `src/cli/index.ts`
```ts
import { Command } from 'commander';
import { VERSION } from '../version.js';
import { printResolvedConfig } from './commands/config.js';
import { replStub } from './commands/repl.js';

export const program = new Command();

program
  .name('kode')
  .description('A local coding agent.')
  .version(VERSION, '-v, --version');

program
  .command('config')
  .description('Print resolved config and discovery trace')
  .action(() => printResolvedConfig(process.cwd()));

program
  .command('repl')
  .description('Start interactive REPL (coming in Phase 1)')
  .action(() => replStub());
```

### 5.12 `src/cli/commands/config.ts`
```ts
import { findConfigFiles } from '../../config/find.js';
import { loadConfig } from '../../config/loader.js';
import { loadEnv, assertApiKey } from '../../config/env.js';
import { logger } from '../../infra/logger.js';

export function printResolvedConfig(cwd: string): void {
  loadEnv(cwd);
  const files = findConfigFiles(cwd);
  logger.debug({ cwd, files }, 'config discovery');
  try {
    const { config } = loadConfig(files);
    console.log('Config files (closest first):');
    if (files.length === 0) console.log('  (none found, using defaults)');
    for (const f of files) console.log('  ' + f);
    console.log('\nResolved config:');
    console.log(JSON.stringify(config, null, 2));
    if (config.model?.apiKeyEnv) {
      const present = assertApiKey(config.model.apiKeyEnv);
      console.log(`\nAPI key (${config.model.apiKeyEnv}): ${present ? 'present' : 'MISSING'}`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
```

### 5.13 `src/cli/commands/repl.ts`
```ts
export function replStub(): void {
  console.log('REPL is not implemented yet — coming in Phase 1.');
}
```

### 5.14 `src/index.ts`
```ts
import { loadEnv } from './config/env.js';
import { program } from './cli/index.js';

const cwd = process.cwd();
loadEnv(cwd);
await program.parseAsync(process.argv);
```

### 5.15 `bin/kode.js`
```js
#!/usr/bin/env node
import '../dist/index.js';
```

### 5.16 `biome.json`
```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "vcs": { "enabled": false, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignore": ["dist", "node_modules", "pnpm-lock.yaml"] },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "formatter": { "enabled": false },
  "organizeImports": { "enabled": false },
  "javascript": { "formatter": { "enabled": false } }
}
```

### 5.17 `.prettierrc`
```json
{ "semi": true, "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

### 5.18 `vitest.config.ts`
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
```

### 5.19 `tests/unit/config.test.ts`（核心单测，示意）
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findConfigFiles } from '../../src/config/find.js';
import { loadConfig } from '../../src/config/loader.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'kode-test-'));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('findConfigFiles', () => {
  it('walks up and finds the closest kode.jsonc', () => {
    const root = join(workdir, 'proj');
    const sub = join(root, 'packages', 'a');
    // 用 mkdirSync(sub, { recursive: true }) 建层级；
    // 在 root 放 kode.jsonc，从 sub 调用 findConfigFiles(sub) 应解析到 root 的文件。
  });
});

describe('loadConfig', () => {
  it('parses valid jsonc with comments and trailing comma', () => {
    const f = join(workdir, 'kode.jsonc');
    writeFileSync(f, '{\n  // project\n  "version": 1,\n}');
    const { config } = loadConfig([f]);
    expect(config.version).toBe(1);
  });

  it('rejects invalid schema with friendly message', () => {
    const f = join(workdir, 'kode.jsonc');
    writeFileSync(f, '{ "model": { "provider": "weird" } }');
    expect(() => loadConfig([f])).toThrow(/provider/);
  });

  it('closest file overrides home-level keys (shallow per-key)', () => {
    const home = join(workdir, 'home', '.kode', 'kode.jsonc');
  });
});
```
> 上述示意未写全目录创建细节；实现时补 `mkdirSync(dir,{recursive:true})`。重点是覆盖：发现顺序、jsonc 注释/尾逗号、schema 报错、覆盖优先级、空配置回退默认。

### 5.20 `docs/examples/kode.jsonc`（示例，**不置仓库根**）
```jsonc
{
  // Phase 0 占位示例；后续阶段补充真实字段场景
  "version": 1,
  "model": {
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-20241022",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "permissions": {
    "default": "confirm",
    "overrides": {
      "fs.read": "allow",
      "fs.glob": "allow",
      "fs.grep": "allow"
    }
  },
  "rules": [
    "Always run `pnpm typecheck` after edits.",
    "Never edit files under dist/."
  ],
  "logLevel": "info"
}
```

### 5.21 `.gitignore`（追加）
```
dist/
node_modules/
.env
.env.local
*.log
~/.kode/
```

## 6. 关键实现设计说明

### 6.1 版本号注入方案
采用**运行时读取 `package.json`**（`src/version.ts` via `createRequire`），而非 tsup `define`：

| 路径 | `import.meta.url` | `../../package.json` 指向 | 可用 |
|---|---|---|---|
| dev (`tsx src/index.ts`) | `src/version.ts` | 仓库根 package.json | ✅ |
| built (`node dist/index.js`) | `dist/index.js`（tsup 单 bundle） | 仓库根 package.json | ✅ |
| npm 安装包 | 包内 `dist/index.js` | 包根 package.json | ✅ |
| pnpm link / 全局 | 实际 `dist/index.js` | 实际 package.json | ✅ |
| bun --compile 单二进制 | — | package.json 不可读 | ❌（Phase 7 才需）|

Phase 7 发布单可执行时再切到 `define` 注入 + 运行时兜底；当前用运行时读取，dev 与 built 行为一致，不分裂。

### 6.2 配置查找与合并语义
- **发现顺序**：cwd 当前层 → 逐层向上到根 → `~/.kode/kode.jsonc`。
- **叠加顺序**：**远者先打底、近者覆盖**（home 作基底，最近项目文件最后覆盖）。
- **合并粒度（Phase 0）**：**浅层 per-key 覆盖**——顶层键整体替换，不做嵌套深度合并，也不合并数组。
  - 例：home 设了 `permissions`，项目也设了 `permissions` → 项目整体胜出（不合并 `overrides`）。
- **可预期升级**：Phase 1+ 按需引入 `deepmerge`/自写深合并（对象合并、`rules` 数组 concat、scalar 近者胜）。届时在 §6.2 标注升级点，保持调用方不变。
- 此设计简单可测；判定“是否需要深合并”放到 §10 风险跟踪。

### 6.3 env 加载顺序与密钥引用
- 加载：`dotenv` 依次读 `${cwd}/.env.local`、`${cwd}/.env`，后者不覆盖前者（dotenv 数组先到先得）。
- 密钥**不进配置文件**：`model.apiKeyEnv` 只记 env 变量名；运行时按名取 `process.env[apiKeyEnv]`。
- Phase 0 行为：缺 key 时 `logger.warn` 一次，**不退出**（因无 LLM 消费）；Phase 1 在真正发请求前会改 hard-fail 或交互式补录。
- 二者顺序：启动时 `loadEnv` 先于 `findConfigFiles/useConfig`（已在 `src/index.ts` 体现）。`config` 子命令演示用途也遵循同一顺序。

### 6.4 logger 目录/级别/轮转
- 目录：`~/.kode/logs/`（homedir 跨平台；`mkdirSync recursive` 创建）。
- 文件：`kode-YYYY-MM-DD.log`（按 UTC 日期，便于回放对齐）。
- 级别：默认 `info`；`KODE_LOG_LEVEL=debug kode` 覆盖；`config.logLevel` 作为同义软配置（env 优先级高于配置文件）。
- 轮转：Phase 0 **不删旧、不切分**；Phase 7 加保留策略（如保留 N 天）。
- 终端输出：Phase 0 不把 logger 输出到 stdout，避免干扰 CLI 文本；只在文件落盘。TUI（Phase 6）会另设一个 `pino-pretty` 控制台 sink。

### 6.5 错误处理与退出码约定（Phase 0 起立规范）
| 场景 | 退出码 | 输出 |
|---|---|---|
| 正常 | 0 | 子命令产物（如 `--version`、`config` 列表） |
| 配置校验失败 | `1` | `ConfigError.message` 到 stderr |
| 配置文件 JSONC 解析失败 | `1` | 含文件名 + 首个错误码 |
| 未捕获异常 | `2` | 简要信息 + 日志文件路径提示 |
| 用户中断（Ctrl-C） | `130` | 静默（Phase 1 起增强） |

约定从 Phase 0 起统一应用，避免后续阶段改约定造成破坏性变更。

### 6.6 schema 演进策略
- 顶层 `version: z.literal(1)`：配置文件必须声明（或缺省默认）`version:1`。
- 由 `version` 决定走哪套迁移器：未来新增 `2` 时，`loader` 内 `if (raw.version === 1) migrate_v1_to_v2(...)`。
- **未知字段**：Phase 0 采用 zod 默认（strip 未知键，不报错）。若需更严格，切 `z.strict()` 并给出友好报错；当前保持宽容，便于用户试验。
- 兼容窗口：每次主版本升级保留 N 个版本的迁移器，文档标注“支持的 `version` 范围”。

## 7. 开发工作流（命令清单）

```bash
pnpm install                                  # 装依赖
pnpm dev                                      # 源码直跑（tsx）
pnpm dev -- --version                         # 等价 kode --version
pnpm dev -- config                            # 等价 kode config
pnpm build                                    # tsup 产物到 dist/
pnpm start -- --version                        # 跑构建产物
pnpm link --global                             # 全局注册 kode（本地开发）
kode --version                                 # 验证全局命令可用
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check   # 一致性闸门
KODE_LOG_LEVEL=debug pnpm dev -- config       # 调试日志
```

> 自链提示：`pnpm link --global` 后修改源码需 `pnpm build` 才生效（dist 才被 bin 加载）；开发态用 `pnpm dev` 即可免构建。

## 8. 验收用例（acceptance）

执行顺序即编号顺序；每条标注命令与期望。

1. **版本** — `kode --version`  → 输出 `0.0.1`。
2. **帮助** — `kode --help`  → 列出 `config`、`repl` 两个子命令，描述正确。
3. **repl stub** — `kode repl`  → 输出 `REPL is not implemented yet — coming in Phase 1.` 退出码 0。
4. **无配置回退** — 在不含任何 `kode.jsonc` 的临时目录运行 `kode config`  → 打印 `(none found, using defaults)` + 合法的默认 config（`{ "version": 1 }`），退出码 0。
5. **项目配置带注释** — 仓库根放 `docs/examples/kode.jsonc` 的精简版（含 `//` 注释与尾逗号），在仓库根运行 `kode config`  → 文件被识别，Resolved config 含其字段。
6. **无效配置** — `kode.jsonc` 写 `{ "model": { "provider": "weird" } }`  → `kode config` 退出码 1，stderr 含 `provider` 字样与定位提示。
7. **JSONC 解析错误** — `kode.jsonc` 写 `{ "version": 1 `（缺闭合）→ `kode config` 退出码 1，错误含文件名 + parse error 提示。
8. **home 兜底** — 删除项目级配置、在 `~/.kode/kode.jsonc` 放一份含 `rules` → `kode config` 列出该 home 文件且 Resolved config 含 `rules`。
9. **项目覆盖 home（浅层）** — home 设 `rules:["a"]`，项目 `kode.jsonc` 设 `rules:["b"]` → Resolved `rules` 为 `["b"]`（整体替换，不 concat）。
10. **向上查找** — 在子目录 `packages/a/`（无该层配置，仓库根有）运行 `kode config` → 列出根配置，正常解析。
11. **日志落盘** — 任意一次 `kode config` 后，`~/.kode/logs/kode-YYYY-MM-DD.log` 存在且为合法 pino JSON 行（含 `level`、`time`、`version`）。
12. **日志级别** — `KODE_LOG_LEVEL=debug kode config` 后日志含 `msg:'config discovery'` 的 debug 行；默认级别下无此行。
13. **env 加载** — 项目根 `.env` 含 `ANTHROPIC_API_KEY=sk-test`，`kode.jsonc` 设 `model.apiKeyEnv` → `kode config` 末行输出 `API key (ANTHROPIC_API_KEY): present`。
14. **缺失 key 警告** — 上条 `.env` 中删除该变量但保留 `apiKeyEnv` → `API key (...): MISSING`，stderr/stdout 含一条 warn，退出码 0。
15. **构建产物** — `pnpm build` 产出 `dist/index.js`、`dist/index.d.ts`、sourcemap；`pnpm start -- --version` 输出版本。
16. **闸门三绿** — `pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check` 全部 0 退出码。
17. **单测覆盖** — `tests/unit/config.test.ts` 至少覆盖 §5.19 列出的发现顺序、jsonc 注释/尾逗号、schema 报错、覆盖优先级、空默认 5 个用例，全绿。

## 9. 验收 Checklist

- [ ] T01–T17 全部完成
- [ ] §8 用例 1–17 全部通过
- [ ] `kode --version` 输出与 `package.json` 一致
- [ ] `kode config` 在「无配置 / 项目 / home / 项目+home 无效」四种情形下行为符合预期
- [ ] 日志文件于 `~/.kode/logs/` 生成且为合法 JSON 行
- [ ] `KODE_LOG_LEVEL` 生效
- [ ] `.env` / `.env.local` 被加载，`apiKeyEnv` 引用检查正常（present/MISSING）
- [ ] 三闸门绿：typecheck / test / lint / format:check
- [ ] `docs/examples/kode.jsonc` 存在且是不含错误的示例
- [ ] `AGENTS.md`（若选做）已写入项目约定
- [ ] 与 `implementation-plan.md` 的配置命名差异已在本文 §1 备注

## 10. 风险与缓解

| 风险 | 触发 | 缓解 |
|---|---|---|
| 向上查找到根碰上无关 `kode.jsonc` | cwd 在 `~` 或 `/` 附近 | MVP 接受；后续加“遇 `.git` 上界”的 stop 规则（§6.2 备注升级点） |
| 浅层合并语义不直观 | 用户期待 `rules` 合并 | 文档显式声明（§6.2）；Phase 1+ 升级深合并并在 CHANGELOG 标注 |
| 命令行 logger 干扰 stdout | 后续 TUI 冲突 | Phase 0 logger 仅落文件；TUI 阶段另开控制台 sink |
| pino 异步 flush 在极端崩溃丢日志 |CLI 短进程 | 采用 `pino.destination`（同步 fd）；写关键路径可改 `pino.extreme` 评估（后置） |
| ESM-only 依赖链 ERR_REQUIRE_ESM | 个别工具只支持 CJS | 装前先探；tsup/biome/vitest/pino/commander/zod 均已 ESM-ready |
| `engines` 锁版本被忽略 | 装到低版本 Node | `package.json` 加 `engines`；后续在发布校验里加 `node-version` 检查（PR 模板/CI，Phase 7） |
| biome+prettier 双 formatter 冲突 | 用户误跑 `biome format` | biome 配置显式 `formatter.enabled:false`（§5.16），README 注明格式化统一走 prettier |

## 11. 工时预估与里程碑

- **总工时**：≈ 12.5–13h（2 个工作日）
- **关键路径**：T01 → T06 → T08 → T11 → T12 → T17
- **Day 1**（~6.5h）：T01–T04、T05、T06、T07、T09、T10、T15、T16
- **Day 2**（~6h）：T08、T11、T12、T13、T14，以及 T17 全量走查
- **里程碑 M0**：§8 用例 1–17 全绿 → 解锁 Phase 1。

## 12. 与主计划的差异备注

| 项 | 主计划 | 本阶段修订 |
|---|---|---|
| 配置文件名 | `opencode.jsonc` | `kode.jsonc`（项目级）；`~/.kode/kode.jsonc`（全局） |
| 配置目录 | 隐含 `.opencode/` 与 `~/.kode/` 并存 | 统一为 `~/.kode/`（logs 与 global config 同根） |
| 工具链 | vitest（Phase 7 才出现） | 提前到 Phase 0 搭好（vitest+biome+prettier） |

> 主计划 `implementation-plan.md` 将在 Phase 0 收尾后做一次同步编辑，确保索引一致。