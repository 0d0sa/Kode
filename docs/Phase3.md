# Phase 3 执行方案：上下文管理

> 对应 `implementation-plan.md` §7 Phase 3。状态：**已实现（2026-07-24）**。项目负责人确认的 `D1-B / D2-B / D3-B / D4-A / D5-B / D6-B / D7-B` 已落入代码、配置、CLI 与自动化测试。

## 0. 阶段定位

Phase 2 已经让 Kode 具备真实仓库所需的搜索、编辑、权限、审计和 undo 能力。现在的主链路是：

`会话完整历史 → trimMessages(最近 20 条) → provider.complete() → 工具结果追加历史`

这个方案能保护短会话，但不能回答三个关键问题：

1. 20 条短消息可能很便宜，20 条巨大工具输出也可能直接超过模型窗口。
2. 当前 `countTokens()` 只是 `chars / 4`，并且没有计算 system prompt、工具 schema 和输出 token 预留。
3. 滑动窗口会整体丢掉早期目标、约束和决策；长任务即使不报超限，也可能“忘记为什么这样改”。

Phase 3 要把固定消息条数窗口替换为真正的 Context Manager，让 Kode 在长任务中知道“还能放多少、应该压缩什么、哪些内容绝不能丢”。

### 0.1 当前实现基线

| 现有基础                       | 当前行为                                               | Phase 3 缺口                                   |
| ------------------------------ | ------------------------------------------------------ | ---------------------------------------------- |
| `trimMessages(messages, keep)` | 默认保留最近 20 条，并向前对齐 tool-use/tool-result 链 | 只看条数，不看 token；长工具链可能突破窗口     |
| `LLMProvider.countTokens()`    | Anthropic/OpenAI 都调用 `estimateTokens(messages)`     | 仅估算消息正文，不含 system、tools 和协议开销  |
| `LLMProvider.modelInfo()`      | 返回硬编码的 200k / 128k 上下文窗口                    | 任意兼容模型、本地模型可能不准确，缺少配置覆盖 |
| `model.maxTokens`              | 作为单次模型输出上限传给 provider                      | 名称容易与“上下文窗口”混淆，不能拿来当输入预算 |
| `ToolResult.output`            | Phase 2 已做行数、条目数和字节上限                     | 多轮累积后仍会占满上下文；缺少历史输出压缩     |
| `TerminalSession.history`      | 保存本进程内完整多轮历史                               | 没有摘要 checkpoint、优先级或 pin 元数据       |
| `agentLoop`                    | 每一步调用前执行 `trimMessages`                        | 已有稳定替换点，但目前是同步纯函数             |
| pino / AgentEvent              | 有模型、工具和权限日志                                 | 没有每轮预算、压缩动作和计数精度报告           |

### 0.2 Phase 3 目标

- 预算覆盖一次真实请求的全部组成：system、工具 schema、消息、协议余量和输出预留。
- 在模型请求前保证输入处于可接受窗口内，而不是依赖 provider 返回超限错误。
- 先压缩历史工具输出，再压缩较旧完整 turn 或已完成 step group；始终保持 provider 合法的消息与工具调用配对。
- 保护当前任务、项目规则、最近约束、未完成工作和最近工具链。
- 通过 `--debug` 展示每轮预算与压缩动作，但不泄露正文或秘密。
- 让 30+ 工具调用的长任务仍能继续，并为 Phase 4 代码库摘要、Phase 5 Planner、Phase 6 会话恢复提供接口。

### 0.3 非目标

- 代码符号索引、语义检索和仓库概览（Phase 4）。
- Todo/Planner、重复调用检测和自动验证规划（Phase 5）。
- 历史落盘、`resume` 和跨进程 summary 恢复（Phase 6）。
- 自动续写被 `max_tokens` 截断的模型回答、流中途断线恢复。
- 精确成本计费、云端遥测或跨用户配额。
- 将完整历史或源码写入普通日志、审计日志。

## 1. 关键设计决策门

以下决策会改变公共接口、配置 schema、依赖、成本或上下文正确性。项目负责人已于 2026-07-24 完成选择；未选方案保留为设计取舍记录，实施必须遵循各节标注的“已确认”方案。

### D1. 输入预算如何确定

| 选项 | 方案                                                                   | 优点                                        | 代价/风险                                                   |
| ---- | ---------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| A    | 完全由配置给出固定 `maxInputTokens`                                    | 行为最可预测；本地模型容易配置              | 用户必须知道每个模型窗口；切模型容易忘记修改                |
| B    | 从 `provider.modelInfo()` 取窗口，减去输出预留和安全余量；允许配置覆盖 | 默认开箱即用，又能纠正兼容端点/本地模型信息 | 需要澄清 `model.maxTokens` 仍是输出上限，并扩展 `ModelInfo` |
| C    | 按模型窗口比例动态分配输入/输出，例如 80%/20%                          | 配置最少，随窗口自动缩放                    | 输出需求差异大；小窗口和大窗口都可能浪费预算                |

**推荐：B。**

推荐口径：

```text
inputLimit =
  contextWindowTokens
  - maxOutputTokens
  - safetyReserveTokens
```

- `model.maxTokens` 保持 Phase 1/2 语义：单次输出上限，不重新解释。
- `ModelInfo.maxTokens` 建议重命名为 `contextWindowTokens`，避免与输出上限混淆。
- 新增可选 `agent.context.windowTokens`，用于本地或 OpenAI-compatible 模型覆盖 provider 默认值。
- `model.maxTokens` 未配置时也必须解析出一个明确的输出上限，并把同一个值同时用于预算预留和 provider 请求，不能“预留 8k、实际无限制”。
- `agent.contextMessages` 暂时继续接受，但不再按 20 条直接丢历史；它只作为旧配置迁移提示/近期原文偏好，token budget 才是正确性边界。

**已确认：B（provider 窗口减去输出预留与安全余量，并允许配置覆盖）。**

### D2. token 计数后端与接口

| 选项 | 方案                                                                       | 优点                                     | 代价/风险                                                        |
| ---- | -------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| A    | 延续同步 `chars / 4`，只补 system/tools 的字符数                           | 无新依赖、无网络、实现最小               | 中文、代码、JSON Schema 和不同协议误差可能很大                   |
| B    | 异步计数链：provider 精确计数（可用时）→ 本地模型 tokenizer → 保守字符估算 | 精度与可用性平衡；能报告 exact/estimated | `countTokens()` 要改为异步请求级接口；可能增加依赖和一次计数调用 |
| C    | 统一使用本地 tokenizer，不调用 provider 计数 API                           | 无额外网络延迟；测试稳定                 | 很难覆盖 Claude、OpenAI-compatible 和任意本地模型的实际模板      |

**推荐：B。**

推荐的新计数边界不是只接收 `messages`，而是接收完整请求：

```ts
interface TokenCountRequest {
  model: string;
  system: string;
  tools: ToolSpec[];
  messages: LLMMessage[];
}

interface TokenCount {
  tokens: number;
  accuracy: 'exact' | 'tokenizer' | 'estimated';
  source: string;
}

interface TokenCounter {
  count(request: TokenCountRequest, signal?: AbortSignal): Promise<TokenCount>;
}
```

provider 精确接口不可用、失败或被限流时必须降级，不能因为“计数服务失败”阻止正常 Agent 请求。实际 tokenizer 包在实现前根据 D2 结果做兼容性验证，不在设计阶段锁死。

**已确认：B（provider 精确计数 → 本地 tokenizer → 保守估算）。**

### D3. 压缩策略是否调用 LLM

| 选项 | 方案                                                                              | 优点                                   | 代价/风险                                           |
| ---- | --------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| A    | 只做确定性压缩：裁剪旧工具输出、保留首尾、丢弃最旧完整 turn/step group            | 无额外模型成本；结果可复现、易回放     | 较早决策和因果关系容易丢失                          |
| B    | 分层混合：确定性压缩工具输出 → LLM 摘要旧完整 turn/已完成 step group → 确定性降级 | 兼顾事实保留和稳定性；最符合主计划目标 | 增加摘要调用、延迟和事实漂移风险                    |
| C    | 让 LLM 重写所有待保留上下文，包括工具输出和旧对话                                 | 摘要最紧凑，策略统一                   | 成本最高；最容易遗漏 hash、路径、失败状态等精确信息 |

**推荐：B。**

选择 B 时，摘要必须使用固定结构，而不是自由散文：

```text
Goal
Constraints
Decisions
Files and edits
Commands and verification
Errors and rejected approaches
Open work
```

工具输出先做确定性压缩，至少保留：工具名、目标路径、成功/失败、关键 hash、退出码、截断标记和与后续 tool result 配对所需的 ID。摘要调用失败、Abort 或输出无效时回退到 A，不中断主任务。

**已确认：B（确定性工具压缩 → LLM 摘要 → 确定性降级）。**

### D4. 摘要使用哪个模型

> 如果 D3 选择 A，本项不适用。

| 选项 | 方案                                                            | 优点                                     | 代价/风险                                                |
| ---- | --------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| A    | 使用当前会话相同 provider 和 model，关闭 tools                  | 不增加新的数据边界和密钥配置；行为最一致 | 主模型可能昂贵、慢；摘要与主请求争用限流                 |
| B    | 在同一 provider 下配置独立 `summaryModel`，未配置时回退当前模型 | 可以使用更便宜、更快的模型               | 增加模型兼容矩阵；弱模型更容易产生错误摘要               |
| C    | 允许独立 provider/model/key                                     | 成本与部署最灵活                         | 源码会被发送到第二个服务；配置、安全和测试复杂度显著增加 |

**推荐：A（Phase 3 先保证数据边界简单）；B 可作为兼容扩展预留。**

无论选择哪项，摘要调用：

- 不注入工具 schema，不允许产生工具调用。
- 与主调用共享 AbortSignal。
- 不计入 Agent `maxSteps`，但计入 context debug 的调用次数和耗时。
- 每个主模型 step 最多触发一次，避免“为了压缩而无限压缩”。

**已确认：A（使用当前会话相同的 provider/model，并关闭 tools）。**

### D5. 原始历史和摘要如何保存

| 选项 | 方案                                                                                       | 优点                                              | 代价/风险                                                  |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------- |
| A    | 直接用摘要替换 `TerminalSession.history` 中的旧消息                                        | 内存最省，后续 resolve 最快                       | 无法重新摘要或调试；摘要错误会永久污染当前会话             |
| B    | 原始历史只追加不改；Context Manager 缓存“前缀摘要 checkpoint + 最近原文”，每次派生请求视图 | 可回放、可重新压缩；不破坏 Phase 1/2 history 语义 | 内存仍随会话增长；需要 checkpoint 失效与合并规则           |
| C    | 将摘要作为普通 synthetic message 追加到原始历史，同时保留被摘要消息                        | 实现直观，历史可见                                | provider 可能同时看到摘要和原文；重复事实与 token 反而增加 |

**推荐：B。**

Phase 3 只做进程内 checkpoint；Phase 6 Session Store 再决定原始历史和摘要如何持久化。建议 checkpoint 带版本与覆盖范围：

```ts
interface ContextCheckpoint {
  version: 1;
  throughMessage: number;
  summary: LLMMessage;
  sourceDigest: string;
  tokenCount: number;
  createdAt: string;
}
```

新消息只使尾部视图变化；被覆盖前缀未变化时复用 checkpoint。不得把摘要写入 permission audit 或普通 info 日志。

**已确认：B（原始历史只追加，派生请求视图使用内存 checkpoint）。**

### D6. 哪些内容永不压缩

| 选项 | 方案                                                                                                 | 优点                                        | 代价/风险                                         |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| A    | 固定规则：system、根任务指令、最近一个 user turn、当前工具链                                         | 简单、可测试                                | 多轮任务中间新增的关键约束可能被摘要              |
| B    | 类型化优先级：自动标记 system/project rules/current turn/current tool chain，并提供内部 `pin` 元数据 | 可以明确保护新增约束；为 Planner/TUI 留接口 | 需要 ContextEntry 或 sidecar 元数据，改动范围更大 |
| C    | 让用户在配置中用正则或关键词声明“关键消息”                                                           | 灵活，几乎不改内部类型                      | 脆弱且难解释；可能被 prompt 内容意外触发          |

**推荐：B。**

推荐优先级：

```ts
type ContextPriority = 'required' | 'high' | 'normal' | 'compressible';
```

- `required`：system prompt、项目 `rules`、根任务指令、最新用户输入、当前未完成 tool-use/tool-result 链。
- `high`：最近用户约束、最近编辑结果、最近验证失败。
- `normal`：普通对话和近期成功结果。
- `compressible`：较旧搜索结果、文件正文、命令输出和已完成中间步骤。

如果选择 B，优先采用 sidecar/ContextEntry，不把内部优先级字段发送给 provider。Phase 3 不增加用户手写 `/pin` 命令；可先保留 API，Phase 6 再提供交互。

**已确认：B（类型化 priority 与内部 pin/sidecar 元数据）。**

### D7. 连受保护内容都放不下时怎么办

| 选项 | 方案                                                                        | 优点                                   | 代价/风险                                |
| ---- | --------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| A    | 立即失败，返回明确的 `ContextBudgetError` 和预算明细                        | 绝不静默丢约束，行为最安全             | 用户需要手动缩短输入或调整模型窗口       |
| B    | 分级应急：先把输出预留降到配置下限，再裁剪未保护内容；required 仍超限则失败 | 能自动挽救边界场景，同时不牺牲核心约束 | 行为比 A 复杂，输出空间可能变小          |
| C    | 无条件从最旧 protected 内容开始硬截断，保证请求一定发出                     | 最少失败                               | 可能丢掉任务目标或规则，产生不可预测修改 |

**推荐：B。**

失败时不得发起主模型请求，也不得修改工作区。错误至少报告：

- 模型窗口、输入上限、输出预留和安全余量。
- system、tools、protected history 各自 token 数。
- 已尝试的压缩动作。
- 可以采取的修复建议（调大窗口覆盖、降低输出预留、缩短当前输入）。

**已确认：B（先缩减输出预留和未保护内容，required 仍超限时失败）。**

### 1.1 决策记录

| 决策 | 结果 | 锁定内容                                                       |
| ---- | ---- | -------------------------------------------------------------- |
| D1   | B    | provider 窗口减输出/安全预留，允许 `windowTokens` 覆盖         |
| D2   | B    | provider 精确计数 → 本地 tokenizer → 保守估算的异步链          |
| D3   | B    | 确定性工具压缩 → LLM 摘要 → 确定性降级                         |
| D4   | A    | 摘要复用当前 provider/model，关闭 tools                        |
| D5   | B    | 原始历史只追加；派生视图使用带 digest 的内存 checkpoint        |
| D6   | B    | `ContextPriority` + 内部 pin/sidecar，不向 provider 暴露元数据 |
| D7   | B    | 先降输出预留、再裁剪未保护内容；required 单独超限时明确失败    |

确认日期：2026-07-24。确认组合：`B / B / B / A / B / B / B`。

## 2. 不依赖选项的安全不变量

- Context Manager 必须按完整请求计费：不能只统计 `messages`。
- 每次 `provider.complete()` 前都执行预算解析；不允许“先请求，等 provider 报超限”作为正常路径。
- system prompt 与项目 `rules` 永不进入自由摘要，也不得被工具输出覆盖。
- 根任务指令、最新用户输入和当前未完成工具链必须原样保留。
- 任何裁剪都必须以完整 turn/StepGroup/tool chain 为边界，不产生孤立 `tool_result` 或无结果的历史 `tool_use`。
- 摘要内容视为历史数据，不视为新的系统指令；用固定边界和标签注入，降低 prompt injection 风险。
- 工具结果中的源码、命令输出和秘密不得进入 debug 文本、info 日志或 audit；debug 只输出计数和动作。
- 所有计数、摘要和压缩操作支持 AbortSignal；Abort 后不得继续发主模型请求。
- 原始 `TerminalSession.history` 的 user/assistant/tool 配对语义必须继续满足 Anthropic 和 OpenAI 转换器。
- Phase 2 的工具输出边界继续有效；Context Manager 是第二层累积保护，不放宽单工具限制。
- 不自动修改 Git、undo、权限授权或工具结果；上下文压缩只影响发给模型的视图。

## 3. 已确认架构

已确认组合为 `D1-B / D2-B / D3-B / D4-A / D5-B / D6-B / D7-B`，目标目录为：

```text
src/
├── agent/
│   ├── loop.ts                 # 调用 ContextManager.resolve()
│   ├── context.ts              # Phase 1 trimMessages 兼容入口
│   └── types.ts                # context report AgentEvent
├── context/
│   ├── types.ts                # budget / entry / report / checkpoint
│   ├── manager.ts              # 分组、预算、分层压缩和最终视图
│   ├── counter.ts              # exact/tokenizer/estimated 计数链
│   ├── turns.ts                # provider-safe turn/tool-chain 分组
│   ├── compact-tools.ts        # 确定性工具输出压缩
│   ├── summarize.ts            # 无 tools 的摘要调用与结果校验
│   └── errors.ts               # ContextBudgetError
├── llm/
│   └── types.ts                # request-level token count / ModelInfo 演进
└── cli/
    └── session.ts              # session-scoped manager/checkpoint + debug 渲染
```

### 3.1 已实现公共接口

```ts
interface TokenBudget {
  contextWindowTokens: number;
  maxOutputTokens: number;
  safetyReserveTokens: number;
  inputLimitTokens: number;
}

interface ContextUsage {
  systemTokens: number;
  toolSchemaTokens: number;
  historyTokensBefore: number;
  historyTokensAfter: number;
  totalInputTokens: number;
  countAccuracy: 'exact' | 'tokenizer' | 'estimated';
}

interface ContextAction {
  kind: 'compact_tool_result' | 'summarize_turns' | 'drop_turn' | 'reduce_output_reserve';
  affectedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
}

interface ContextResolution {
  messages: LLMMessage[];
  maxOutputTokens: number;
  report: ContextReport;
  checkpoint?: ContextCheckpoint;
}

interface ContextResolveRequest {
  model: string;
  system: string;
  tools: ToolSpec[];
  messages: readonly LLMMessage[];
  requestedOutputTokens: number;
  signal?: AbortSignal;
}

interface ContextManager {
  resolve(request: ContextResolveRequest): Promise<ContextResolution>;
  recordToolResult(toolCallId, name, input, result): void;
  pinMessage(message, priority?): void;
  reset(): void;
}
```

`resolve()` 变为异步，因为精确计数和 LLM 摘要都可能发生 I/O。Agent Loop 仍只负责编排，不包含具体压缩业务。

### 3.2 turn、step group 与工具链边界

Context Manager 不能按数组下标直接切割，也不能等整个用户 turn 完成后才允许压缩；否则一次含 30+ 工具调用的任务会把全部中间结果都锁为不可压缩。建议先构造两级边界：

```text
Turn
  plain user instruction
  StepGroup 1: assistant text/tool_use + matching user tool_result(s)
  StepGroup 2: assistant text/tool_use + matching user tool_result(s)
  ...
  assistant final text
```

- 含 `tool_result` 的 `role: user` 消息不是新用户 turn。
- 同一 assistant 消息中的多个 tool-use 与下一条 user 消息中的结果视为一个不可拆分组。
- 已完成的旧 turn 可以整体摘要。
- 当前 turn 中已经拿到全部结果的旧 StepGroup 可以压缩/摘要，以支持 30+ 工具调用。
- 最新用户输入、正在执行的 StepGroup、缺结果的工具调用和最近若干 StepGroup 只能原样保留。
- 派生视图中的 checkpoint summary 必须放在 provider 合法的 user 边界；必要时作为带 `<history-summary>` 标签的 text block 附加到保留的根 user message，不能制造连续 assistant 或孤立 tool message。

### 3.3 分层 resolve 流程

```text
完整历史
  │
  ├─ 1. 分组并标记 required/high/normal/compressible
  ├─ 2. 计算 system + tools + history + output reserve
  │       └─ 已在预算内：直接返回
  ├─ 3. 压缩旧 tool_result（确定性，保持 ID 与结果状态）
  │       └─ 已在预算内：返回
  ├─ 4. 摘要最旧的完整 turn/已完成 StepGroup，并生成或推进 checkpoint
  │       └─ 已在预算内：返回
  ├─ 5. 丢弃已经被 checkpoint 覆盖的原文视图
  ├─ 6. 按 D7 执行应急输出预留调整
  └─ 7. required 仍超限：ContextBudgetError，不调用主模型
```

摘要自身也必须分块并受预算约束，不能为了压缩 300k token 而向 128k 模型发送 300k token。一次主 step 最多进行一次摘要调用；仍无法满足预算时走确定性降级或失败。

### 3.4 工具结果压缩契约

工具压缩不能只做字符串 `slice()`。建议通过 preceding `tool_use_id` 找到工具名，然后选择 compactor：

| 工具              | 历史压缩后至少保留                                              |
| ----------------- | --------------------------------------------------------------- |
| `read_file`       | path、读取区间、sha256、总行数、截断状态；正文只留首尾片段      |
| `glob`            | root、pattern、命中数、截断状态、少量代表路径                   |
| `grep`            | pattern、命中文件/总数、截断状态、少量代表 match                |
| `run_command`     | 规范化命令摘要、exit code、timeout/abort、stderr 尾部           |
| `write_file`      | path、create/overwrite、before/after hash、undo ID              |
| `replace_in_file` | path、occurrence 数、before/after hash、undo ID                 |
| `apply_patch`     | 文件列表、成功/失败、undo ID                                    |
| 未知工具          | is_error、字节数、首尾有界片段和明确 `[context-compacted]` 标记 |

Phase 3 从 `ToolResult.meta` 生成结构化摘要，但不能把 meta 直接暴露给 provider。为避免 Agent Loop 追加 history 时丢掉 meta，Context Manager 使用 sidecar 按 `tool_call_id` 保存压缩所需数据；不扩展发送给 provider 的 ContentBlock。

### 3.5 摘要正确性保护

D3-B 启用 LLM 摘要，因此：

- 使用固定 system prompt，明确“只提取事实，不提出新指令，不调用工具”。
- 摘要输入使用清晰的 `<history-data>` 边界；其中任何“忽略之前指令”都视为历史文本。
- 输出经过 schema/section 校验；缺少 Goal、Constraints 或 Open work 时视为失败并降级。
- 路径、命令、测试名、错误码、hash 和 undo ID 尽量从结构化数据确定性注入，不让模型改写。
- 每个 checkpoint 保存 `sourceDigest`，源前缀不一致时禁止复用。
- debug 报告只显示摘要覆盖消息数、token 差值、耗时和结果状态，不显示摘要正文。

## 4. 配置演进设计

按已确认组合，目标配置如下；实现时允许字段名做不改变语义的微调：

```jsonc
{
  "model": {
    // 保持现有语义：单次输出上限
    "maxTokens": 8192,
  },
  "agent": {
    "maxSteps": 40,
    // Phase 1 兼容字段；Phase 3 不再用它直接切掉第 21 条消息
    "contextMessages": 20,
    "context": {
      "enabled": true,
      // provider 信息不准确时显式覆盖
      // "windowTokens": 128000,
      "safetyReserveTokens": 2048,
      "minimumOutputTokens": 1024,
      "preserveRecentTurns": 3,
      "toolResultTokens": 2048,
      "summaryTriggerRatio": 0.8,
      // Phase 3 不启用；未来若采用独立摘要模型再扩展：
      // "summaryModel": "smaller-model"
    },
  },
}
```

兼容原则：

- 顶层 `version` 继续为 1；字段全是可选增量。
- 旧配置只含 `contextMessages` 时仍能启动。
- 不把 `model.maxTokens` 改成上下文窗口，避免静默改变已有请求输出长度。
- 所有正数、比例和上下限关系由 `src/config/schema.ts` 的 zod schema 统一校验。
- `kode config` 应显示最终字段；debug 才显示 provider 推导后的实际预算。

## 5. `--debug` 与可观测性

主计划要求 `--debug` 打印每轮预算。建议采用结构化 report + 终端可读渲染，具体 UI 不作为决策门：

```text
[context] window=128000 input_limit=117760 output=8192 safety=2048
[context] before=121432 after=64210 accuracy=estimated
[context] compacted_tool_results=8 summarized_turns=5 checkpoint=1
```

- `kode repl --debug`、`kode run --debug "..."` 均支持；bare `kode --debug` 也应进入 debug REPL。
- debug 写 `stderr`，避免污染 `kode run` 的正常回答 stdout。
- 同一报告以结构化字段写 pino debug 日志，但不得包含消息、摘要或工具正文。
- 建议新增 `AgentEvent`：

```ts
{
  type: 'context';
  report: ContextReport;
}
```

TerminalSession 只负责渲染；未来 TUI 和回放测试可直接消费 report。

## 6. 工作分解（WBS）

| ID  | 任务                                           | 依赖       | 产出                      |
| --- | ---------------------------------------------- | ---------- | ------------------------- |
| T01 | 将已确认的 D1–D7 落入 schema 和接口            | —          | Phase3.md、schema 草案    |
| T02 | 请求级 TokenCounter 与计数精度标记             | D1,D2      | `context/counter.ts`      |
| T03 | turn/tool-chain 分组与 priority sidecar        | D5,D6      | `context/turns.ts`、types |
| T04 | 预算器：system/tools/history/output/safety     | T02,T03    | budget 纯函数             |
| T05 | 工具结果确定性 compactor                       | T03        | `compact-tools.ts`        |
| T06 | 摘要器、固定 prompt、校验与 fallback           | D3,D4,T02  | `summarize.ts`            |
| T07 | checkpoint 和 Context Manager resolve pipeline | D5,T04–T06 | `manager.ts`              |
| T08 | Agent Loop 接入异步 resolve 与 context event   | T07        | loop/types                |
| T09 | Session 生命周期、Abort、debug 渲染            | T08        | session/CLI               |
| T10 | config schema、兼容迁移提示、示例              | D1,D4,D6   | config/docs               |
| T11 | provider `ModelInfo` 和计数接口演进            | D1,D2      | llm types/providers       |
| T12 | 单元、provider 兼容、长链路集成测试            | 全部       | tests                     |
| T13 | README、AGENTS、主计划和阶段状态同步           | T12        | docs                      |

### 6.1 工期影响

- D3-A + D6-A 的纯确定性版本：约 3 个工作日，接近主计划。
- **已确认组合**（异步计数、LLM 摘要、checkpoint、类型化 priority）：约 4–5 个工作日。
- D4-C 独立 provider 或本阶段加入用户 `/pin`：再增加约 1–2 个工作日，不建议放入 Phase 3。

## 7. 测试策略

### 7.1 单元测试

- 预算：system/tools/messages/output/safety 每部分都计入，边界值和配置覆盖正确。
- 计数：exact、tokenizer、estimated 降级顺序；计数失败不阻断主任务。
- turn 分组：多 tool-use、批量 tool-result、文本混合、缺失结果、多个用户 turn。
- priority：required 永不进入摘要；最近约束与当前链正确标记。
- compactor：每个 Phase 2 工具保留关键字段，未知工具安全退化，输出有 token/字节双上限。
- checkpoint：source digest、复用、推进、失效和原始历史不变。
- 摘要：固定结构校验、prompt injection 文本、空输出、超时、Abort 和 provider 错误 fallback。
- 极限溢出：按 D7 缩减或失败，不调用主模型、不执行工具。
- debug：只含数字/动作，不含源码、API key、命令秘密。

### 7.2 集成测试

- mock provider 设置很小窗口，构造 30+ 工具调用，确认每一步请求都不超过 input limit。
- 同一脚本分别覆盖 Anthropic/OpenAI 消息转换，压缩后无孤立 tool call。
- 长 `read_file`、`grep`、`run_command` 输出反复累积后触发分层压缩。
- 早期任务目标、项目 rules、后加约束和最近失败在压缩后仍可见。
- summary provider 返回错误时走确定性 fallback，Agent 仍完成下一步。
- summary 期间 Ctrl-C，确认主模型请求和后续工具均不执行。
- `--debug` 的 stdout/stderr 分离，one-shot 输出仍适合脚本使用。
- 旧 `contextMessages` 配置可以启动，不再静默按条数丢历史，并输出明确兼容行为。

### 7.3 回归门禁

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm build
```

Phase 0–2 的 96 项测试必须继续通过；新增测试不得访问真实模型、真实网络、真实 `~/.kode` 或用户项目。

## 8. 验收用例

1. **预算完整性**：debug 中 system、tools、history、output reserve 与总数关系一致。
2. **窗口内直通**：短会话不压缩、不调用 summarizer，发送内容与 Phase 2 等价。
3. **工具优先压缩**：旧大工具输出先被压缩，路径、状态、hash、exit code 不丢。
4. **旧历史摘要**：预算继续不足时才摘要已经完成的旧 turn 或旧 StepGroup。
5. **关键内容保护**：初始目标、项目规则、当前用户输入和当前工具链始终原样存在。
6. **provider 合法性**：压缩后的 Anthropic/OpenAI 请求都保持 tool-use/tool-result 配对。
7. **30+ 工具任务**：配置足够 `maxSteps` 后，mock 长任务不因输入超窗终止。
8. **计数降级**：精确计数不可用时自动切 tokenizer/estimate，并在 debug 标明精度。
9. **摘要失败**：超时、Abort、无效输出或限流不会留下半个 checkpoint。
10. **极限超限**：required context 单独超窗时按 D7 明确失败，且没有工具副作用。
11. **兼容配置**：Phase 2 配置不修改即可启动；`model.maxTokens` 继续控制输出。
12. **隐私**：debug、pino、audit 中不出现测试源码、摘要正文或测试密钥。
13. **Phase 2 回归**：搜索、编辑、权限、audit、undo 和 CLI 冒烟保持通过。

## 9. 完成定义

- [x] D1–D7 已由项目负责人确认并回写本文。
- [x] 完整请求 token budget 与至少两级计数 fallback 完成。
- [x] 工具输出压缩、旧 turn 处理和 protected context 有自动化测试。
- [x] Context Manager 不产生孤立 tool-use/tool-result。
- [x] 摘要失败和 Abort 有确定性 fallback，不污染 checkpoint。
- [x] `--debug` 可解释每轮预算且不泄露内容。
- [x] 30+ 工具调用的 mock 验收在小窗口下通过。
- [x] Phase 0–2 回归和五项门禁全绿。
- [x] README、AGENTS、配置示例和主计划同步。
- [x] Phase 3 文档从“设计已确认”更新为“已实现”。

## 10. 风险与缓解

| 风险                  | 影响                     | 缓解                                                        |
| --------------------- | ------------------------ | ----------------------------------------------------------- |
| 计数低估              | provider 拒绝请求        | 安全余量、精度标记、配置窗口覆盖、失败时保守降级            |
| 计数过高              | 过早压缩、浪费上下文     | exact/tokenizer 优先；缓存静态 system/tools 计数            |
| 摘要事实漂移          | 改错文件或忘记约束       | required 原文、固定结构、结构化字段确定性注入、原始历史保留 |
| 摘要 prompt injection | 历史工具输出改变摘要指令 | 数据边界、无 tools、固定 system、输出校验                   |
| 工具配对被切断        | provider 400 或行为异常  | 先构造完整 turn/tool-chain，再做压缩                        |
| 压缩递归/成本失控     | 延迟和费用不可控         | 每 step 最多一次摘要，失败走确定性 fallback                 |
| 本地/兼容模型窗口未知 | 错误预算                 | `windowTokens` 配置覆盖 + 明确 debug 来源                   |
| checkpoint 过期       | 发送旧事实               | source digest 与覆盖范围校验，历史只追加                    |
| debug 泄密            | 源码或密钥进入终端/日志  | report 字段 allowlist，只记录计数、动作与耗时               |
| 历史内存持续增长      | 长 REPL 占用内存         | Phase 3 有界 checkpoint 缓存；持久化与长期清理留 Phase 6    |

## 11. 与后续阶段的接口

- Phase 4 可把仓库概览作为 `high` priority context source 注入，不需要改预算器。
- Phase 5 Planner 可把当前计划、未完成 todo 标为 `required/high`，并消费 ContextReport 判断是否需要缩小任务。
- Phase 6 Session Store 可持久化 raw history、checkpoint、priority sidecar 和 source digest；TUI 可渲染 context event。
- Phase 7 回放测试可以固定 TokenCounter 和 Summarizer，实现完全确定性的预算回放。

D1–D7 已全部实现。后续如需改变预算语义、摘要数据边界、checkpoint 结构或 protected context 规则，必须先回写本文。
