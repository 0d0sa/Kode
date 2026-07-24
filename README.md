# Kode

A local coding agent (TypeScript CLI).

> Status: **Phase 4 (codebase understanding)**. Kode supports streaming chat,
> Anthropic/OpenAI-compatible providers, repository search and editing, scoped
> permissions, audit logs, undo, token-aware context management, and a local
> multi-language symbol/dependency index. See `docs/implementation-plan.md` and
> the phase documents in `docs/`.

## Requirements

- Node.js >= 20.11
- pnpm (`npm install -g pnpm` if missing)

## 启动教程

### 1. 安装依赖

克隆项目后进入 Kode 仓库：

```bash
git clone <your-kode-repository-url>
cd Kode
pnpm install
```

### 2. 配置模型

在准备让 Agent 操作的项目目录中创建 `kode.jsonc`。直接调试 Kode
自身时，可以在当前 Kode 仓库根目录创建：

```jsonc
{
  "version": 1,
  "model": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "maxTokens": 8192,
  },
  "agent": {
    "maxSteps": 40,
  },
  "codebase": {
    "enabled": true,
    "languages": ["typescript", "javascript", "python", "go", "rust"],
  },
  "permissions": {
    "default": "confirm",
    "overrides": {
      "read_file": "allow",
      "glob": "allow",
      "grep": "allow",
      "list_symbols": "allow",
      "find_definition": "allow",
      "find_references": "allow",
      "module_dependencies": "allow",
    },
  },
}
```

将模型名替换为账号实际可用的模型。完整配置参考
[`docs/examples/kode.jsonc`](docs/examples/kode.jsonc)。

把 API Key 写入同一项目目录下的 `.env.local`：

```dotenv
ANTHROPIC_API_KEY=your-api-key
```

`.env.local` 已被 Git 忽略，不要把真实 Key 写入 `kode.jsonc` 或提交到仓库。
使用 OpenAI 时，将 provider、模型和环境变量改为：

```jsonc
{
  "model": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiKeyEnv": "OPENAI_API_KEY",
  },
}
```

连接本地 OpenAI-compatible 服务时不需要真实 Key，但必须设置 `baseURL`：

```jsonc
{
  "model": {
    "provider": "local",
    "model": "your-local-model",
    "baseURL": "http://127.0.0.1:8000/v1",
  },
}
```

### 3. 检查配置

从源码检查版本和最终配置：

```bash
pnpm dev -- --version
pnpm dev -- config
```

`config` 会显示找到的配置文件、脱敏后的合并结果，以及配置引用的 API Key
环境变量是否存在。

### 4. 启动 Agent

交互式 REPL：

```bash
pnpm dev -- repl
```

也可以直接运行 `pnpm dev`，裸命令默认进入 REPL。进入后直接描述任务，例如：

```text
> 阅读这个项目，找到配置加载入口并解释它
> 修复相关 bug，修改前先告诉我方案
```

REPL 内置命令：

- `/help`：查看帮助。
- `/clear`：清空当前进程中的对话历史和上下文 checkpoint。
- `/undo`：确认后撤销最近一组文件修改。
- `/exit` 或 `/quit`：退出。
- 任务执行中按 `Ctrl-C`：中止当前模型、摘要或工具调用。

执行一次任务后退出：

```bash
pnpm dev -- run "阅读 package.json 并总结项目命令"
```

默认情况下，写文件、执行命令和访问工作区外路径会请求确认。非交互脚本可以使用
`--yes` 自动批准，但只应在可信工作区使用：

```bash
pnpm dev -- run --yes "运行测试并修复失败"
```

查看每一步的 token 预算和压缩动作：

```bash
pnpm dev -- run --debug "检查这个仓库的当前状态"
pnpm dev -- repl --debug
```

Debug 信息写入 stderr，正常回答仍写入 stdout；报告只包含计数和动作，不包含源码、
摘要正文或 API Key。Phase 4 还会输出 repository context source 的版本、token 数和
是否纳入本轮请求。

### 5. 构建并使用 `kode` 命令

```bash
pnpm build
node dist/index.js repl
node dist/index.js run "检查当前项目"
```

如果希望像其他终端 coding agent 一样在任意仓库直接运行，可在 Kode 仓库中建立
全局链接：

```bash
pnpm build
pnpm link --global
```

然后切换到目标项目。Kode 会把启动命令所在目录作为工作区：

```bash
cd /path/to/your-project
kode config
kode
# 等价于：kode repl
```

目标项目需要自己的 `kode.jsonc` 和 `.env.local`，或者使用全局配置
`~/.kode/kode.jsonc` 并通过 shell 导出相应 API Key。配置查找顺序是当前目录逐级
向上，最后回退到全局配置。

如果不想建立全局链接，也可以从目标项目直接调用构建产物：

```bash
cd /path/to/your-project
node /absolute/path/to/Kode/dist/index.js repl
```

### 6. 常见问题

- `No model configured`：当前目录及父目录没有 `kode.jsonc`，全局配置也不存在。
- `Missing API key`：检查 `.env.local` 的变量名是否与 `apiKeyEnv` 完全一致。
- 本地模型拒绝连接：确认服务已启动，且 `baseURL` 包含正确的 OpenAI-compatible
  API 前缀。
- Agent 拒绝修改或执行命令：检查 `permissions`；默认的确认行为是安全保护。
- 需要诊断上下文：加 `--debug`；普通运行日志位于 `~/.kode/logs/`。
- 需要恢复最近文件修改：在 REPL 中执行 `/undo`；快照位于 `~/.kode/undo/`。
- 代码索引暂时显示 `building`：首次启动会在后台解析；代码理解工具会等待当前
  generation 完成，之后启动会复用 `~/.kode/index/` 缓存。
- 某种语言未被索引：确认扩展名受支持、文件没有被 `.gitignore` 排除，并检查
  `codebase.languages`。损坏或版本不兼容的缓存会被忽略并自动重建。

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

## Built CLI quick check

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

Kode exposes eleven bounded tools to the model:

- `glob` and `grep` discover files and text. They prefer ripgrep and fall back
  to a Node implementation when `rg` is unavailable.
- `read_file` streams UTF-8 text and returns a SHA-256 hash.
- `write_file` creates files or explicitly overwrites a file using that hash.
- `replace_in_file` performs exact, hash-guarded replacements.
- `apply_patch` dry-runs a multi-file unified diff before changing any target.
- `run_command` executes a bounded, cancellable bash command.
- `list_symbols` lists indexed declarations with bounded filtering and pagination.
- `find_definition` returns ranked definition candidates instead of silently
  choosing an ambiguous match.
- `find_references` returns syntactic reference/call candidates together with
  index coverage and freshness.
- `module_dependencies` reports bounded import/export/module edges and unresolved
  specifiers.

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

Phase 4 enables `codebase` indexing by default. It parses TypeScript/TSX,
JavaScript, Python, Go, and Rust using bundled, fixed-version tree-sitter WASM
grammars. A lightweight repository overview is attached to the current user turn
as bounded, untrusted context; it never modifies the system prompt or stored
history. The full symbol/reference/dependency generation is cached under
`~/.kode/index/` and refreshed after successful Kode edits or undo. Set
`codebase.enabled` to `false` to disable indexing and unregister the four codebase
tools. Phase 4 deliberately performs no embedding or remote semantic indexing;
`find_references` is syntactic, so important conclusions should still be verified
with `read_file` or `grep`.

Use `--debug` with `kode`, `kode repl`, or `kode run` to print numeric context
budget and compaction diagnostics to stderr. Message bodies, summaries, source
text, and keys are never included in that report.
