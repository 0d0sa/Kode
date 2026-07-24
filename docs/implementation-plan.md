# Kode 实现计划

> 本地 CLI Coding Agent —— 基于 TypeScript 的分模块设计与实现路线图

## 1. 文档说明

本文定义 Kode 的整体架构、模块划分与分阶段实现计划，作为开发的统一蓝图。后续如需细化，可在 `docs/` 下拆出子文档（如 `modules/llm.md`、`modules/tools.md`）并在此引用。

## 2. 项目目标与范围

### 2.1 目标

构建一个运行在终端本地的 coding agent，能够：

- 读写本地代码库、执行 shell 命令、运行搜索；
- 与 LLM（Anthropic / OpenAI / 本地模型）对话式协作完成软件工程任务；
- 自主进行多步任务规划、工具调用与自检（运行 lint/test/typecheck）；
- 在 token 预算内管理上下文，支持大型代码库理解。

### 2.2 本期范围

- **形态**：本地 CLI / REPL，单机本进程执行；
- **模型**：云端优先（Anthropic、OpenAI），可配置；
- **暂不做**：远程多租户服务、IDE 插件（留扩展位）、沙箱化容器执行（MVP 用受限本机执行 + 二次确认）。

### 2.3 非功能目标

- **确定性**：工具行为可复现、可回放；
- **可控**：所有破坏性操作需显式确认；
- **可观测**：每轮 LLM 调用、工具调用有结构化日志；
- **可扩展**：新增工具、新增模型、新增 UI 均不动核心循环。

## 3. 设计原则

| 原则         | 含义                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| 工具即边界   | 核心只做规划与调度；一切副作用都通过工具发生，便于审计与回放               |
| 接口优先分层 | LLM、工具、上下文、UI 均以接口抽象，实现可替换                             |
| 声明式工具   | 每个工具声明 `inputSchema` / 是否只读 / 是否需确认，框架据此自动校验与拦截 |
| 流式贯穿     | LLM、工具输出全程 `AsyncIterable`，UI 可增量渲染                           |
| 单一事件总线 | agent 循环产出 `AgentEvent`，持久化、UI、日志都订阅同一事件流              |
| 渐进信任     | 默认只读自动执行；写/执行类工具分级确认，可配置放权                        |

## 4. 总体架构

### 4.1 分层

```
┌───────────────────────────────────────────────┐
│ Interface Layer  (CLI / REPL / Ink TUI 渲染)    │
├───────────────────────────────────────────────┤
│ Agent Layer      (Agent Loop / 规划 / 事件流)    │
├───────────────────────────────────────────────┤
│ Core Services    (LLM Provider / Context /      │
│                   Tool Registry / Permission)    │
├───────────────────────────────────────────────┤
│ Tools            (File / Shell / Search /       │
│                   Edit / Todo / Codebase)       │
├───────────────────────────────────────────────┤
│ Foundation       (Config / Storage / Logger /   │
│                   Pkg/Build / Telemetry)        │
└───────────────────────────────────────────────┘
```

### 4.2 核心数据流（一次 agent turn）

```
用户输入
  └─► Prompt 组装（system + 注入：规则/工具说明/代码库概览）
        └─► ContextManager.resolve() （token 预算、压缩、窗口选择）
              └─► LLMProvider.complete()  ──流式──► AgentEvent
                    │ 文本块 ─► UI 渲染
                    └─ 工具调用块 ─► ToolRegistry.dispatch()
                          └─ 权限门 ─► 执行 ─► ToolResult
                                └─ 追加为 message ─► 下一轮循环（直到无 tool_call）
```

## 5. 模块清单与职责

模块 ID 用于路线图引用。

| ID  | 模块              | 层         | 职责一句话                                        |
| --- | ----------------- | ---------- | ------------------------------------------------- |
| M01 | Agent Loop        | Agent      | 编排 LLM↔工具的循环，产出 AgentEvent              |
| M02 | Prompt Manager    | Agent      | 组装 system prompt、工具说明、代码库摘要          |
| M03 | Task Planner      | Agent      | Todo 列表、子任务分解、日志式进度跟踪             |
| M04 | LLM Provider      | Core       | 多模型抽象、流式、重试、token 计数、函数调用      |
| M05 | Tool Registry     | Core       | 工具注册、schema 校验、并发调度、只读判定         |
| M06 | Permission System | Core       | 确认门、危险操作拦截、放权配置、审计日志          |
| M07 | Context Manager   | Core       | token 预算、压缩、窗口管理、消息裁剪              |
| M08 | Session Store     | Core       | 会话持久化、resume、checkpoint、回放              |
| M09 | File Tools        | Tools      | read / write / edit / glob / grep（封装 ripgrep） |
| M10 | Shell Tool        | Tools      | bash 执行、超时、输出截断、依赖工具白名单         |
| M11 | Edit Engine       | Tools      | 整文件替换、字符串精确替换、diff/patch 应用       |
| M12 | Codebase Index    | Tools      | 文件树、git ignore 识别、符号表（tree-sitter）    |
| M13 | Semantic Search   | Tools      | （可选）嵌入索引 + 向量检索，跨文件定位           |
| M14 | Todo Tool         | Tools      | 供 agent 自管理的结构化任务列表（M03 的工具面）   |
| M15 | CLI / REPL        | Interface  | argv 解析、REPL、流式输出渲染                     |
| M16 | Renderer          | Interface  | markdown、代码高亮、diff、进度/确认 UI（Ink）     |
| M17 | Config System     | Foundation | kode.jsonc、`.env`、模型/规则/放权配置            |
| M18 | Logger            | Foundation | 结构化日志（pino）、调试模式、事件落盘            |
| M19 | Build & Dist      | Foundation | tsup/bun 打包、单可执行分发、跨平台脚本           |
| M20 | Telemetry         | Foundation | （可选）指标、错误上报（本地、可关）              |

### 5.1 关键模块补充说明

**M01 Agent Loop**

- 单一 `async function* agentLoop(opts): AsyncIterable<AgentEvent>`；
- 每轮：组装 prompt → 调 LLM → 解析 tool_use → 执行 → 追加 result → 继续/终止；
- 终止条件：无 tool_use / 达到步数上限 / 用户中断 / 错误。
- **不包含**任何业务逻辑，便于测试（对 mock LLM/provider 可快进回放）。

**M04 LLM Provider**

- 统一 `complete()` 返回 `AsyncIterable<StreamEvent>`，屏蔽 Anthropic/OpenAI 差异；
- 负责重试（429/5xx + 指数退避）、token 计数代理、流式中断恢复；
- 向上暴露 `modelInfo()`（max tokens、是否支持 tool-use、定价）。

**M05 Tool Registry**

- 工具声明 `inputSchema`（JSON Schema）供框架注入模型 + 运行时校验；
- `isReadOnly` 决定是否默认放行；`requiresConfirmation` 可为布尔或函数；
- 支持命名空间（如 `fs.read`）与工具版本，便于演进。

**M06 Permission System**

- 决策点：工具执行前 → 查策略表 → `allow / confirm / deny`；
- 策略来源：默认策略 + `kode.jsonc` 放权 + 运行时用户授权 + 会话级放权范围（如“本次任务允许所有写操作”）；
- 每次决策写审计日志（含 input 摘要）。

**M07 Context Manager**

- 维护 token 预算：保留 `system + 最近 N 轮 + 工具摘要`，溢出则压缩（先压缩工具输出 → 摘要旧消息 → 截断大输出）；
- 提供 `resolve(): LLMMessage[]` 供 Loop 使用；
- 关键设计：压缩不丢“当前任务指令与最近约束”。

**M11 Edit Engine**

- 严格模式：`oldString` 唯一匹配才应用，否则报错（避免误改）；
- 支持 `replaceAll`、整文件覆写、unified diff/patch；
- 写前自动保留原文件到 `.kode/undo/`（MVP）或与 git 暂存交互。

## 6. 关键接口设计（TypeScript）

```ts
// —— 5 —— //
// ============ LLM ============
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface LLMMessage {
  role: Role;
  content: string | ContentBlock[];
}

export interface CompleteOptions {
  model: string;
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'stop'; reason: 'end_turn' | 'tool_use' | 'max_tokens' };

export interface LLMProvider {
  complete(messages: LLMMessage[], opts: CompleteOptions): AsyncIterable<StreamEvent>;
  countTokens(messages: LLMMessage[]): number;
  modelInfo(model: string): { maxTokens: number; supportsToolUse: boolean };
}

// ============ Tool ============
export interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  isReadOnly?: boolean;
  requiresConfirmation?: boolean | ((input: unknown, ctx: ToolContext) => boolean);
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  cwd: string;
  abort: AbortSignal;
  approve: (req: ApprovalRequest) => Promise<ApprovalResult>;
  logger: Logger;
}

export interface ToolResult {
  ok: boolean;
  output: string; // 供模型消费的主要文本（可被压缩）
  isStructured?: boolean;
  meta?: Record<string, unknown>;
}

// ============ Tool Registry ============
export interface ToolRegistry {
  register(t: Tool): void;
  specs(): ToolSpec[]; // 注入给 LLM
  dispatch(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// ============ Agent ============
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: ToolResult }
  | { type: 'step'; index: number };

export interface AgentRunOptions {
  messages: LLMMessage[];
  tools: string[];
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

export interface Agent {
  run(opts: AgentRunOptions): AsyncIterable<AgentEvent>;
}

// ============ Context ============
export interface ContextManager {
  push(m: LLMMessage): void;
  resolve(): LLMMessage[]; // 应用预算后消息
  budget(): TokenBudget;
}

// ============ Permission ============
export type Decision = 'allow' | 'confirm' | 'deny';
export interface ApprovalRequest {
  tool: string;
  input: unknown;
  reason?: string;
}
export type ApprovalResult = { decision: Decision; scope?: 'once' | 'session' };
```

## 7. 分阶段实现路线图

> 每个阶段以「可用增量」收尾：跑得起来、能验收。模块 ID 见 §5。

### Phase 0 — 脚手架（地基）⏱ ~2 天

- **目标**：可构建、可发布空 CLI、可加载配置。
- **实现模块**：M15(骨架) M17 M18 M19
- **交付物**：
  - `pnpm`/`bun` 工程、tsconfig、tsup 构建；
  - `kode` 命令可打印版本；
  - 读取 `kode.jsonc`（zod 校验）、`.env`（模型密钥）；
  - pino 日志落 `~/.kode/logs/`。
- **验收**：`kode --version` 输出版本；错误配置有清晰报错。
- **难点**：配置 schema 的演进策略（保留 `unknown` 字段、版本号）。

### Phase 1 — 最小 Agent（能对话改代码）⏱ ~4 天

- **目标**：单轮/多轮对话 + 3 个工具（read / edit / bash）形成闭环。
- **实现模块**：M01 M02 M04 M05 M09(read) M10(bash) M11(edit) M15(REPL)
- **交付物**：
  - 接 Anthropic 与 OpenAI-compatible provider，流式文本输出到终端；
  - `read_file`、`replace_in_file`、`run_command` 三工具；
  - REPL：输入 prompt → agent 多步用工具 → 回答；
  - 简单 ABI 预算（固定保留最近 20 条消息）。
- **验收**：能完成“读 README，加一节 Installation，并 `node -v` 确认”这类任务。
- **难点**：tool_use 流式解析、中断（Ctrl-C）时未完成调用的清理。

### Phase 2 — 工具与权限完善 ⏱ ~5–6 天

> 详细执行方案与已确认设计决策见 [`Phase2.md`](./Phase2.md)。
> **状态：已实现（2026-07-24）**，自动化回归与构建门禁已覆盖核心验收路径。

- **目标**：搜索 + 编辑健壮性 + 危险操作确认。
- **实现模块**：M06 M09(glob/grep) M09(write) M11(diversified)
- **交付物**：
  - `glob` + `grep`：ripgrep 优先，Node fallback；
  - `write_file`、严格 `replace_in_file`、原子多文件 `apply_patch`；
  - canonical path 工作区边界，越界访问单独确认；
  - 工具 + 路径 + 命令前缀的有序权限规则，细粒度 session/once 放权；
  - `~/.kode/undo/` 全局快照与 REPL `/undo`；
  - `~/.kode/audit/` 独立 JSONL 权限审计。
- **验收**：对一个真实仓库跑“找到所有 `TODO` 并改成 `FIXME`”，中途需确认且可拒绝。
- **难点**：ripgrep 未安装时的降级；Edit 在大文件上的性能。

### Phase 3 — 上下文管理 ⏱ ~3 天

- **目标**：在长任务中不爆 token、不丢关键指令。
- **实现模块**：M07
- **交付物**：
  - token 预算器（provider 计数 + 本地估算兜底）；
  - 压缩策略：① 截断/摘要工具输出 ② 摘要旧消息 ③ 保留首尾；
  - `--debug` 可打印每轮预算使用。
- **验收**：在一个大型仓库跑一个会调 30+ 工具的任务，仍稳定不超限。
- **难点**：摘要引入的事实漂移；需要“永不压缩”的关键消息标记。

### Phase 4 — 代码库理解 ⏱ ~4 天

- **目标**：自动理解项目结构、符号、依赖关系。
- **实现模块**：M12 M13(可选) M02(注入概览)
- **交付物**：
  - 仓库概览（文件树 + 类型/栈识别 + 入口文件 + 模块依赖图）注入 prompt；
  - tree-sitter 符号表：`find_definition` `list_symbols` 工具；-（可选）向量检索：`semantic_search`（嵌入入库、sqlite-vec / hnswlib）；
  - 增量索引 + gitignore 过滤。
- **验收**：“定位 `handleError` 的所有调用处并解释其异常处理策略”可一次完成。
- **难点**：多语言 grammar 安装与打包体积；索引冷启动耗时。

### Phase 5 — 任务规划与自检 ⏱ ~3 天

- **目标**：分解复杂任务、跟踪进度、自跑验证闭环。
- **实现模块**：M03 M14
- **交付物**：
  - `todo_write` 工具：结构化任务列表、渲染为可勾选 panel；
  - 规划器：复杂请求自动产出 todo 并逐步推进；
  - 自检约定：约定 lint/typecheck/test 为收尾强制步骤（可配置）；
  - 后台/并发任务（M05 并发调度）。
- **验收**：“加一个新 endpoint 并补单测，最后 `pnpm test`” 整条流程自走完成。
- **难点**：子任务失败回退策略；防止陷入循环。

### Phase 6 — 交互体验（TUI / 多模型 / 会话）⏱ ~4 天

- **目标**：从「能用」到「好用」。
- **实现模块**：M16(Ink) M04(多 provider) M08
- **交付物**：
  - Ink 富 TUI：流式 markdown、代码高亮、diff view、确认框、进度条；
  - 多 provider 切换（Anthropic / OpenAI / 本地 Ollama-compatible）；
  - 会话保存/resume（`--resume <id>`）、checkpoint。
- **验收**：中断/退出后能在另一终端 `kode --resume <id>` 继续。
- **难点**：TUI 与日志/输出的并存（alt buffer、滚动与流式冲突）。

### Phase 7 — 工程化与发布 ⏱ ~3 天

- **目标**：稳定、可分发、可维护。
- **实现模块**：M19(分发) M20 vitest 测试 M18 可观测
- **交付物**：
  - 单元测试：LLM mock、工具纯函数、Edit/Context 单测 + 对真实仓库的回放测试（fixture）；
  - bun 编译为单可执行 / NPM 发布 / Homebrew 方案；
  - 默认遥测本地（可关）、crash 上报开关；
  - README + `AGENTS.md`（给 agent 自己看的项目约定）。
- **验收**：新机器一行命令安装并完成 demo 任务。
- **难点**：跨平台（Windows shell 脚本分支）；单文件体积与首启速度。

### 路线图总览

| Phase | 主题             | 时长  | 里程碑           |
| ----- | ---------------- | ----- | ---------------- |
| 0     | 脚手架           | ~2d   | `kode --version` |
| 1     | 最小 Agent       | ~4d   | 能改 README      |
| 2     | 工具/权限        | ~5–6d | 批量改 TODO      |
| 3     | 上下文管理       | ~3d   | 长任务不爆 token |
| 4     | 代码库理解       | ~4d   | 跨文件定位       |
| 5     | 规划/自检        | ~3d   | 自动补单测       |
| 6     | 体验/多模型/会话 | ~4d   | resume 续会话    |
| 7     | 工程化/发布      | ~3d   | 单命令安装       |

**MVP（对外可用）= Phase 1–3 合并体**，约 2.5 周。

## 8. 建议目录结构

```
Kode/
├── src/
│   ├── agent/            # M01 loop  M02 prompt  M03 planner
│   ├── llm/              # M04 providers (anthropic.ts openai.ts local.ts)
│   ├── tools/            # M05 registry + 各工具实现
│   │   ├── fs/           # M09 read/write/edit/glob/grep
│   │   ├── shell/        # M10
│   │   ├── edit/         # M11
│   │   ├── codebase/     # M12  M13
│   │   └── todo/         # M14
│   ├── context/          # M07
│   ├── permission/       # M06
│   ├── session/          # M08
│   ├── cli/              # M15 argv + REPL
│   ├── tui/              # M16 Ink 组件（phase 6）
│   ├── config/           # M17
│   │   └── schema.ts
│   ├── infra/            # M18 logger  M19 build辅助  M20 telemetry
│   └── index.ts
├── docs/
│   ├── implementation-plan.md
│   ├── Phase0.md
│   └── examples/
│       └── kode.jsonc    # 用户示例（不置仓库根，避免干扰发现逻辑）
├── tests/
│   ├── unit/
│   ├── replay/          # 录制的真实会话回放
│   └── fixtures/
├── kode.jsonc            # 项目自身配置（开发 Kode 时所用）
├── AGENTS.md             # 给 agent 自己看的项目约定
├── package.json
└── tsconfig.json
```

## 9. 技术选型清单（TypeScript）

| 领域       | 选型                                                  | 备注                           |
| ---------- | ----------------------------------------------------- | ------------------------------ |
| 运行时     | Node 20+（兼容 bun 可执行编译）                       | LTS                            |
| 构建       | tsup（基于 esbuild）                                  | 快，零配置 TS                  |
| 包管理     | pnpm                                                  |                                |
| CLI        | commander（先期）；Ink + react（TUI 阶段）            |                                |
| LLM SDK    | @anthropic-ai/sdk、openai（不直连 litellm）           | 多 provider 自抽象             |
| Schema     | zod                                                   | 配置与工具入参都在一个地方校验 |
| 文件搜索   | ripgrep（调用二进制；无则降级 fast-glob + 自身 grep） |                                |
| Glob       | fast-glob                                             |                                |
| 代码解析   | tree-sitter（web-tree-sitter） + 各语言 grammar WASM  | 跨平台、易打包                 |
| 向量检索   | sqlite-vec 或 hnswlib-node（可选）                    | 嵌入走 API 或 transformers.js  |
| 本地存储   | better-sqlite3                                        | 会话/索引                      |
| 高亮       | cli-highlight / shiki（TUI）                          |                                |
| diff       | diff                                                  |                                |
| 日志       | pino                                                  |                                |
| 测试       | vitest                                                |                                |
| Token 计数 | provider 接口优先；兜底 gpt-tokenizer / tiktoken      |                                |

## 10. 风险与难点

| 风险                     | 影响                  | 缓解                                                         |
| ------------------------ | --------------------- | ------------------------------------------------------------ |
| 上下文压缩导致事实漂移   | agent 改错文件/老 API | 关键消息标“永不压缩”；压缩前留可回滚摘要                     |
| 工具副作用不可逆         | 误删/误执行           | 默认 confirm + `~/.kode/undo/` 全局快照；不自动更改 Git 状态 |
| 多模型 tool-use 行为差异 | 切模型即崩            | provider 抽象层做归一 + 集成测试矩阵                         |
| 流式中断/取消不一致      | 卡死/泄漏子进程       | AbortSignal 贯穿到底；子进程随取消 kill                      |
| tree-sitter 打包过大     | 安装臃肿              | grammar 按语言延迟加载/按需下载                              |
| 长任务循环不收敛         | token/时间爆炸        | maxSteps 硬上限 + 重复检测 + 步数预算                        |
| Windows shell 兼容       | Windows 用户异常      | shell 工具走 `cmd`/pwsh 分支、统一 UTF-8 输出                |

## 11. 验收与里程碑

- **M0（Phase 0 末）**：`kode --version` + 配置/密钥读取正常。
- **M1（Phase 1 末·MVP 起点）**：完成 README 修改类任务。
- **M3（Phase 3 末·MVP 完成）**：Kode-MVP 可对外发布，能跑真实仓库的中小任务。
- **M5（Phase 5 末）**：能独立完成“加测试 + 跑测试”闭环。
- **M6（Phase 6 末）**：TUI 体验稳定、多模型、resume 齐备。
- **M7（Phase 7 末·v1.0）**：单命令安装、文档完整、回放测试覆盖核心路径。

## 12. 后续可拆分文档

按模块成熟度，逐步从本计划拆出细化文档（保持本文为索引）：

- `docs/modules/llm-provider.md` — 多模型归一、流式、重试
- `docs/modules/tools.md` — 工具规范、新增工具 checklist
- `docs/modules/context.md` — 预算、压缩、摘要策略
- `docs/modules/permission.md` — 策略表、确认 UX、审计
- `docs/modules/agent-loop.md` — 事件流、回放、中止语义
- `docs/conventions/agents.md` — 与 `AGENTS.md` 同源的内部约定
