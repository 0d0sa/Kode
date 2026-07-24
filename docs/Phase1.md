# Phase 1 执行方案：最小 Agent（能对话改代码）

> 对应 `implementation-plan.md` §7 Phase 1。本文是该阶段可落地的执行手册：选型、任务、文件内容、验收。前置：Phase 0 已完成（M0 达成）。

## 0. 阶段定位

在 Phase 0 的地基（构建链 / 配置 / 日志 / CLI 骨架）之上，长出**能跑通闭环的最小 Agent**：
单/多轮对话 + 流式输出 + 3 个工具（`read_file` / `replace_in_file` / `run_command`）+ REPL。
本阶段结束即达成 **M1（MVP 起点）**：Kode 能自主完成“读 README → 加一节 Installation → 跑 `node -v` 确认”这类任务。

**覆盖模块**：M01(Agent Loop) M02(Prompt，最小版) M04(LLM Provider，Anthropic + OpenAI-compatible) M05(Tool Registry) M09(read) M10(bash) M11(edit/replace) M15(REPL)。

**MVP 关系**：Phase 1 是 MVP（Phase 1–3 合并体）的核心增量；本阶段刻意不做权限策略表（Phase 2）、token 预算（Phase 3），只做最小可用闭环。

### 0.1 相比 Phase 0，实际新增了什么

Phase 0 解决的是“项目能不能正常启动”：有 TypeScript 工程、构建测试命令、配置发现、环境变量、日志和 CLI 外壳，但还不能向模型提问，也不能读写代码或运行命令。

Phase 1 把这套外壳接成了一个真正可以工作的最小编码 Agent：

| 能力           | Phase 0                                      | Phase 1 的实际增量                                                                   |
| -------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| CLI            | `--version`、`config` 和尚未实现的 REPL 占位 | 裸 `kode`/`kode repl` 进入多轮会话；`kode run` 支持一次性任务和 `--yes`              |
| 模型连接       | 只读取 API key 配置，不发起模型请求          | 接入 Anthropic 与 OpenAI-compatible 双协议，支持流式文本和流式工具调用               |
| Agent 执行     | 没有 Agent Loop                              | 建立“模型思考 → 调工具 → 回灌结果 → 继续思考”的多步循环，并限制最大步数              |
| 代码操作       | 没有可用工具                                 | 增加 `read_file`、`replace_in_file`、`run_command` 三个工具，形成读、改、验证闭环    |
| 输入校验       | 只有配置 zod schema                          | 每个工具用 zod 定义唯一 schema，同时派生给模型使用的 JSON Schema                     |
| 权限控制       | 只有配置字段，没有实际执行门                 | 只读工具自动允许；修改和命令默认确认；支持 once、session、deny 和非 TTY 默认拒绝     |
| 会话上下文     | 没有消息历史                                 | 保存多轮历史，默认保留最近 20 条，并保护 user/assistant 与 tool_use/tool_result 配对 |
| 中断与进程清理 | 没有运行中的任务                             | AbortSignal 贯穿 SDK、确认、工具和重试；命令按进程组终止，并有 SIGKILL 兜底          |
| 错误与退出码   | 主要覆盖配置加载错误                         | 缺模型/密钥、模型请求失败和 Ctrl-C 都有终端提示及可用于脚本判断的退出码              |
| 自动化验证     | Phase 0 配置、日志和 CLI 骨架测试            | 增加 provider 转换、loop、上下文、权限和三工具回归测试；当前共 66 个单元测试         |

实际运行时，一条用户指令会按下面的闭环处理：

1. REPL 或 `kode run` 接收指令，把 system prompt 和历史消息交给 provider。
2. provider 将不同厂商的消息格式转换成统一事件，并把文本增量直接输出到终端。
3. 如果模型请求工具，Agent Loop 把调用交给 Tool Registry。
4. Registry 校验参数、执行权限决策，必要时询问用户，再调用具体工具。
5. 工具结果以 `tool_result` 回灌模型；模型可以继续调用工具，直到给出最终回答或达到停止条件。

因此，Phase 1 的核心成果不是“多了几个命令”，而是首次打通了：

`用户指令 → 模型判断 → 读取代码 → 经确认修改/执行 → 将结果交回模型 → 总结`

这个闭环给后续阶段提供了稳定扩展点：Phase 2 可以在 Registry 上增加更多工具、权限策略和 undo；Phase 3 可以替换上下文窗口和 token 估算；后续 UI、并行调度和会话持久化也可以复用现有 Session、Agent Loop 与 Provider 接口。

### 0.2 当前边界

Phase 1 已经是可运行的最小 Agent，但还不是完整编码产品：目前没有 `glob`/`grep`/`write_file`、编辑撤销、完整审计、token 压缩、会话恢复、并行工具调度和图形化 TUI。这些能力分别留给后续阶段，避免在最小闭环稳定前过早增加复杂度。

## 1. 设计选型确认（决策汇总）

| 维度            | 决策                                                          | 说明                                                                          |
| --------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| LLM SDK         | **@anthropic-ai/sdk + openai**                                | Anthropic 兼容与 OpenAI 兼容双协议（用户决策）；base_url/model/api_key 均可配 |
| 工具入参 schema | **zod 单一来源 + zod-to-json-schema 派生 JSON Schema**        | 运行时校验与注入 LLM 的 schema 不手写两份                                     |
| 流式 tool_use   | **缓冲到 `content_block_stop` 再一次性产出**                  | 文本增量直发；工具入参 partial JSON 不逐增量上抛（见 §6.1）                   |
| 权限（最小门）  | **config `permissions` + REPL 行内确认**                      | 非只读工具默认 confirm；支持 once/session；完整 M06 仍在 Phase 2              |
| 上下文预算      | **滑动窗口：保留最近 20 条消息 + tool 配对对齐**              | 主计划“简单 ABI 预算”的具体化（见 §6.4）；token 预算留 Phase 3                |
| Agent Loop      | 单一 `async function* agentLoop(): AsyncIterable<AgentEvent>` | 不含业务逻辑，对 mock provider 可回放测试                                     |
| REPL            | `node:readline`（暂不引 Ink）                                 | Ink TUI 在 Phase 6；本阶段纯文本流式渲染                                      |
| 一次性执行      | 新增 `kode run "<prompt>" [--yes]`                            | 主计划只写 REPL；one-shot 便于验收/脚本化（见 §12 差异）                      |
| 中断            | AbortSignal 全链路（SDK signal / spawn kill / 退避可断）      | Ctrl-C 两级：运行中先 abort，空闲再退（退出码 130）                           |
| 重试            | 429/5xx/529 最多重试 3 次（总计最多 4 次请求）                | 关闭 SDK 内置重试，避免叠乘；流中途错误直接上抛（见 §6.6）                    |
| token 计数      | chars/4 估算兜底                                              | `LLMProvider.countTokens` 接口先立，真实计数 Phase 3 接                       |

**与主计划差异**：见 §12（含 `CompleteOptions` 增加 `system`、`ToolContext.abort`→`signal`、确认门提前等）。

## 2. 范围

### 2.1 必做（in-scope）

- `src/llm/`：公共类型（沿用主计划 §6 接口）、Anthropic/OpenAI-compatible provider（流式 + 重试 + 消息转换）、工厂 `createProvider(config)`
- `src/tools/`：Tool/ToolContext/ToolResult 类型、Registry（注册/校验/确认门/结构化日志）、三个工具：
  - `read_file`（行号输出、offset/limit 分页、截断保护）
  - `replace_in_file`（严格唯一匹配 + `replace_all`、写回、结果摘要）
  - `run_command`（bash 执行、进程组超时/取消、流式有界尾部缓冲）
- `src/agent/`：`AgentEvent` 类型、`agentLoop`（多步 tool_use 循环、maxSteps 上限、abort 优雅退出）、滑动窗口 `trimMessages`、system prompt 组装（环境信息 + `config.rules` + 工具约定）
- `src/cli/`：真 REPL（多轮历史、流式渲染、行内 approve、Ctrl-C、斜杠命令）、`kode run` 一次性命令、缺 model/API key 时友好报错退出码 1
- config schema 增补 `agent` 段（`maxSteps` / `contextMessages`）
- 单测：消息转换、窗口裁剪、registry 确认门、三工具（tmpdir fixture）、loop（mock provider 回放）
- 文档同步：`AGENTS.md` 布局标注、`docs/examples/kode.jsonc`、README 极简补充

### 2.2 不做（out-of-scope，留给后续阶段）

- 权限策略表、审计日志落盘、`.kode/undo/`（Phase 2）
- `write_file`、`glob`、`grep` 工具（Phase 2）
- token 预算与压缩、`countTokens` 真实计数（Phase 3）
- 会话持久化 / resume（Phase 6）
- ~~OpenAI / 本地 provider 实现~~（按用户决策提前到 Phase 1：openai/local 走 OpenAI 兼容协议）
- Ink TUI、markdown 高亮、diff view（Phase 6）
- 并行工具调度（Phase 5；Phase 1 顺序执行）
- 流中途断线恢复（Phase 3+；Phase 1 上抛报错）

### 2.3 可选附加

- `kode run` 的 `--yes`（自动放行全部确认，脚本/验收用；默认关，文档标警示）。**建议做**，成本低且验收用例需要。

## 3. 任务拆解（WBS）

| ID  | 任务                                                                            | 依赖    | 产出                                    | 估时  |
| --- | ------------------------------------------------------------------------------- | ------- | --------------------------------------- | ----- |
| T01 | 新增依赖（@anthropic-ai/sdk、openai、zod-to-json-schema）+ schema 增 `agent` 段 | —       | package.json、config/schema.ts          | 0.5h  |
| T02 | LLM 公共类型 `src/llm/types.ts`                                                 | —       | types.ts                                | 1h    |
| T03 | Anthropic/OpenAI 消息转换（内部消息 ↔ 厂商协议）                                | T02     | convert-anthropic.ts、convert-openai.ts | 1.5h  |
| T04 | Anthropic/OpenAI provider（流式 + tool_use 缓冲 + 重试）                        | T02,T03 | anthropic.ts、openai.ts                 | 3.5h  |
| T05 | provider 工厂 `createProvider`                                                  | T04     | llm/index.ts                            | 0.5h  |
| T06 | Tool 类型 + Registry（zod 校验 + 确认门 + 日志）                                | —       | tools/types.ts、registry.ts             | 2h    |
| T07 | `read_file` 工具                                                                | T06     | tools/fs/read.ts                        | 1.5h  |
| T08 | `replace_in_file` 工具（严格唯一匹配）                                          | T06     | tools/edit/replace.ts                   | 2h    |
| T09 | `run_command` 工具（进程组超时/中断、流式有界截断）                             | T06     | tools/shell/run.ts                      | 2.5h  |
| T10 | 默认注册器 `createDefaultRegistry`                                              | T07–T09 | tools/index.ts                          | 0.5h  |
| T11 | `AgentEvent` + `agentLoop`                                                      | T02,T06 | agent/types.ts、loop.ts                 | 3h    |
| T12 | 滑动窗口 `trimMessages`（含 tool 配对对齐）                                     | T02     | agent/context.ts                        | 1h    |
| T13 | system prompt 组装 `buildSystemPrompt`                                          | —       | agent/prompt.ts                         | 1h    |
| T14 | 终端会话执行器（渲染 + approve + Ctrl-C）                                       | T11     | cli/session.ts                          | 3h    |
| T15 | REPL 实现 + `run` 命令 + CLI 接线                                               | T14     | repl.ts、run.ts、cli/index.ts           | 2.5h  |
| T16 | 单测（convert/context/registry/三工具/loop mock）                               | 各实现  | tests/unit/*                            | 4h    |
| T17 | 文档同步（AGENTS.md、examples/kode.jsonc、README）                              | —       | 文档更新                                | 0.75h |
| T18 | 验收走查（§8 全部用例）                                                         | 全部    | 验收记录                                | 1.5h  |

**合计 ≈ 31–32h ≈ 4 个工作日**（与主计划预估 ~4 天一致）。

关键路径：T01 → T02 → T03 → T04 → T05 → T15 → T18；T06 → T07/T08/T09 → T10 → T11 → T14 与之并行推进。

## 4. 工程目录（Phase 1 结束时的产物树）

```
Kode/
├── package.json                # 编辑：+@anthropic-ai/sdk +openai +zod-to-json-schema
├── src/
│   ├── index.ts                # 不变（引导）
│   ├── version.ts              # 不变
│   ├── agent/
│   │   ├── types.ts            # AgentEvent / AgentRunOptions
│   │   ├── loop.ts             # agentLoop 生成器
│   │   ├── context.ts          # trimMessages 滑动窗口
│   │   └── prompt.ts           # buildSystemPrompt（M02 最小版）
│   ├── llm/
│   │   ├── types.ts            # LLMMessage / StreamEvent / LLMProvider / ToolSpec
│   │   ├── convert-anthropic.ts # 内部消息 ↔ Anthropic 参数
│   │   ├── anthropic.ts        # AnthropicProvider
│   │   ├── convert-openai.ts   # 内部消息 ↔ OpenAI chat.completions 参数
│   │   ├── openai.ts           # OpenAIProvider（OpenAI 兼容端点通用）
│   │   └── index.ts            # createProvider(config)
│   ├── tools/
│   │   ├── types.ts            # Tool / ToolContext / ToolResult / Approval*
│   │   ├── registry.ts         # ToolRegistry（校验/确认门/日志）
│   │   ├── index.ts            # createDefaultRegistry
│   │   ├── fs/read.ts          # read_file
│   │   ├── edit/replace.ts     # replace_in_file
│   │   └── shell/run.ts        # run_command
│   ├── cli/
│   │   ├── index.ts            # 编辑：+repl 真实现、+run、默认命令=repl
│   │   ├── session.ts          # 终端会话执行器（REPL/run 共用）
│   │   └── commands/
│   │       ├── config.ts       # 不变
│   │       ├── repl.ts         # 编辑：stub → 真实现
│   │       └── run.ts          # 新增：一次性执行
│   ├── config/                 # schema.ts 增 agent 段；其余不变
│   └── infra/logger.ts         # 不变
├── tests/
│   └── unit/
│       ├── llm-convert.test.ts
│       ├── agent-context.test.ts
│       ├── agent-loop.test.ts
│       ├── tools-registry.test.ts
│       ├── tools-read.test.ts
│       ├── tools-replace.test.ts
│       └── tools-run.test.ts
└── docs/
    ├── implementation-plan.md
    ├── Phase0.md
    ├── Phase1.md               # 本文
    └── examples/kode.jsonc     # 编辑：工具名对齐 + agent 段
```

## 5. 关键文件内容（可直接落地）

> 以下代码按 Phase 0 约定书写：ESM、`.js` 相对导入、`import type`、strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。标注“示意”处实现时补全细节。

### 5.1 `src/config/schema.ts`（增量）

```ts
export const AgentConfigSchema = z.object({
  maxSteps: z.number().int().positive().optional(),
  contextMessages: z.number().int().positive().optional(),
});

// ConfigSchema 增加一行：
//   agent: AgentConfigSchema.optional(),
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
```

> 默认值的常量（`DEFAULT_MAX_STEPS = 25`、`DEFAULT_CONTEXT_MESSAGES = 20`）放 `src/agent/types.ts`，不进 schema——schema 只描述用户可配项，缺省由消费方补。

### 5.2 `src/llm/types.ts`

```ts
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

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CompleteOptions {
  model: string;
  system?: string; // Anthropic 的 system 是独立参数，不进 messages
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'stop'; reason: 'end_turn' | 'tool_use' | 'max_tokens' };

export interface ModelInfo {
  maxTokens: number;
  supportsToolUse: boolean;
}

export interface LLMProvider {
  complete(messages: LLMMessage[], opts: CompleteOptions): AsyncIterable<StreamEvent>;
  countTokens(messages: LLMMessage[]): number;
  modelInfo(model: string): ModelInfo;
}
```

### 5.3 `src/llm/convert.ts`

```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, LLMMessage } from './types.js';

/** 内部消息 → Anthropic 参数。system 抽出为独立字段；role 'tool' 仅以 ToolResultBlock[] 形式支持。 */
export function toAnthropicMessages(messages: LLMMessage[]): {
  system?: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      if (typeof m.content === 'string') {
        throw new Error("role 'tool' requires ToolResultBlock[] content");
      }
      out.push({ role: 'user', content: m.content.map(toAnthropicBlock) });
      continue;
    }
    out.push({
      role: m.role, // 'user' | 'assistant'
      content: typeof m.content === 'string' ? m.content : m.content.map(toAnthropicBlock),
    });
  }
  return {
    ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
    messages: out,
  };
}

function toAnthropicBlock(b: ContentBlock): Anthropic.ContentBlockParam {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: b.content,
        ...(b.is_error !== undefined ? { is_error: b.is_error } : {}),
      };
  }
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
```

> 约束：Anthropic 要求 user/assistant 严格交替、且每个 tool_use 后紧跟含对应 tool_result 的 user 消息。Phase 1 由 loop 的追加顺序天然保证；convert 不做重排，违反时让 API 报错上浮（记日志）。

### 5.4 `src/llm/anthropic.ts`

```ts
import Anthropic from '@anthropic-ai/sdk';
import { childLogger } from '../infra/logger.js';
import { toAnthropicMessages } from './convert.js';
import type { CompleteOptions, LLMMessage, LLMProvider, ModelInfo, StreamEvent } from './types.js';

const log = childLogger('llm');
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 529]);
const MAX_RETRIES = 3;

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string;
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: 0, // 统一由本层重试，避免与 SDK 默认重试叠乘
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async *complete(messages: LLMMessage[], opts: CompleteOptions): AsyncIterable<StreamEvent> {
    const converted = toAnthropicMessages(messages);
    const system = opts.system ?? converted.system;
    const req: Anthropic.MessageCreateParamsStreaming = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 8192,
      messages: converted.messages,
      stream: true,
      ...(system ? { system } : {}),
      ...(opts.tools?.length ? { tools: opts.tools as Anthropic.Tool[] } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };
    log.debug({ model: opts.model, msgs: converted.messages.length }, 'llm request');

    const stream = await this.createWithRetry(req, opts.signal, 0);

    // tool_use 缓冲：partial JSON 累积到 block_stop 再一次性产出（§6.1）
    let pending: { id: string; name: string; json: string } | null = null;
    for await (const ev of stream) {
      switch (ev.type) {
        case 'content_block_start':
          if (ev.content_block.type === 'tool_use') {
            pending = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
          }
          break;
        case 'content_block_delta':
          if (ev.delta.type === 'text_delta') {
            yield { type: 'text', delta: ev.delta.text };
          } else if (ev.delta.type === 'input_json_delta' && pending) {
            pending.json += ev.delta.partial_json;
          }
          break;
        case 'content_block_stop':
          if (pending) {
            yield {
              type: 'tool_use',
              id: pending.id,
              name: pending.name,
              input: safeParseJson(pending.json),
            };
            pending = null;
          }
          break;
        case 'message_delta':
          if (ev.delta.stop_reason) {
            yield { type: 'stop', reason: mapStopReason(ev.delta.stop_reason) };
          }
          break;
      }
    }
  }

  private async createWithRetry(
    req: Anthropic.MessageCreateParamsStreaming,
    signal: AbortSignal | undefined,
    attempt: number,
  ): Promise<AsyncIterable<Anthropic.MessageStreamEvent>> {
    try {
      return await this.client.messages.create(req, { signal });
    } catch (e) {
      if (
        e instanceof Anthropic.APIError &&
        RETRYABLE_STATUS.has(e.status) &&
        attempt < MAX_RETRIES
      ) {
        const waitMs = 2 ** attempt * 1000 + Math.random() * 500;
        log.warn(
          { status: e.status, attempt, waitMs },
          'llm request retryable failure, backing off',
        );
        await sleep(waitMs, signal);
        return this.createWithRetry(req, signal, attempt + 1);
      }
      throw e;
    }
  }

  countTokens(messages: LLMMessage[]): number {
    // Phase 1 兜底：chars/4 估算；真实计数 Phase 3 接 provider 接口
    let chars = 0;
    for (const m of messages) {
      chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
    }
    return Math.ceil(chars / 4);
  }

  modelInfo(_model: string): ModelInfo {
    return { maxTokens: 200_000, supportsToolUse: true };
  }
}

function mapStopReason(r: string): 'end_turn' | 'tool_use' | 'max_tokens' {
  if (r === 'tool_use') return 'tool_use';
  if (r === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {}; // 解析失败 → 空入参，交给工具 zod 校验报错回灌模型（§6.1）
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

> 注：SDK 的类型导出路径随版本略有差异（`Anthropic.MessageParam` 等命名空间类型）；实现时以所装版本为准微调 import，行为约定不变。

### 5.5 `src/llm/index.ts`

```ts
import type { Config, ModelConfig } from '../config/schema.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import type { LLMProvider } from './types.js';

const DEFAULT_KEY_ENV: Record<ModelConfig['provider'], string | undefined> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  local: undefined,
};

export class ProviderConfigError extends Error {
  override name = 'ProviderConfigError';
}

export function createProvider(config: Config): { provider: LLMProvider; model: string } {
  const model = config.model;
  if (!model) {
    throw new ProviderConfigError(
      'No model configured. Add a "model" section to kode.jsonc (see docs/examples/kode.jsonc).',
    );
  }
  if (model.provider === 'local' && !model.baseURL) {
    throw new ProviderConfigError(
      'model.baseURL is required when model.provider is "local"; refusing to use the public OpenAI endpoint.',
    );
  }
  const apiKey = resolveApiKey(model);
  const provider =
    model.provider === 'anthropic'
      ? new AnthropicProvider({ apiKey, ...(model.baseURL ? { baseURL: model.baseURL } : {}) })
      : new OpenAIProvider({ apiKey, ...(model.baseURL ? { baseURL: model.baseURL } : {}) });
  return { provider, model: model.model };
}

function resolveApiKey(model: ModelConfig): string {
  if (model.apiKey) return model.apiKey;
  if (model.apiKeyEnv) {
    const value = process.env[model.apiKeyEnv];
    if (value) return value;
    throw new ProviderConfigError(`Missing API key: env var ${model.apiKeyEnv} is not set.`);
  }
  const envName = DEFAULT_KEY_ENV[model.provider];
  const value = envName ? process.env[envName] : undefined;
  if (value) return value;
  if (model.provider === 'local') return 'kode-local';
  throw new ProviderConfigError(`Missing API key: set ${envName}.`);
}
```

> Phase 0 的 `assertApiKey` 只 warn；Phase 1 起真正消费密钥，缺 key 在 `createProvider` 处 hard-fail（由 CLI 捕获 → 友好文案 + 退出码 1）。
>
> **实施修订（用户决策）**：工厂按双协议实现——`anthropic` → AnthropicProvider；`openai`/`local` → OpenAIProvider（OpenAI 兼容端点）。apiKey 解析顺序：`model.apiKey` 直写 → `env[model.apiKeyEnv]` → provider 默认环境变量（`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`）→ 仅 `local` 用占位 key。schema 相应新增 `model.apiKey` 可选字段；`local` 必须配置 `baseURL`，避免漏配时误连公网 OpenAI。`kode config` 展示内联 key 时必须脱敏。

### 5.6 `src/tools/types.ts`

```ts
import type { Logger } from 'pino';
import type { ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface Tool<I = unknown> {
  name: string;
  description: string;
  /** 运行时校验（单一来源） */
  schema: ZodType<I>;
  /** 注入 LLM 的 JSON Schema，由 schema 派生 */
  inputSchema: Record<string, unknown>;
  isReadOnly: boolean;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  approve(req: ApprovalRequest): Promise<ApprovalResult>;
  isSessionApproved(toolName: string): boolean;
  approveSession(toolName: string): void;
  logger: Logger;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  meta?: Record<string, unknown>;
}

export interface ApprovalRequest {
  tool: string;
  input: unknown;
  reason?: string;
}

export interface ApprovalResult {
  decision: 'allow' | 'deny';
  scope?: 'once' | 'session';
}

/** zod → JSON Schema（去 $schema 键，适配 Anthropic input_schema） */
export function toInputSchema(schema: ZodType): Record<string, unknown> {
  const js = zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}
```

### 5.7 `src/tools/registry.ts`

```ts
import { childLogger } from '../infra/logger.js';
import type { Permissions } from '../config/schema.js';
import type { ToolSpec } from '../llm/types.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

const log = childLogger('tools');

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(private permissions: Permissions = {}) {}

  register(t: Tool): void {
    this.tools.set(t.name, t);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  /** 决策：overrides 优先；只读默认 allow；其余默认 confirm（可被 permissions.default 覆盖） */
  private decisionFor(t: Tool): 'allow' | 'confirm' | 'deny' {
    const override = this.permissions.overrides?.[t.name];
    if (override) return override;
    if (t.isReadOnly) return 'allow';
    return this.permissions.default ?? 'confirm';
  }

  async dispatch(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const t = this.tools.get(name);
    if (!t) return { ok: false, output: `Unknown tool: ${name}` };

    const parsed = t.schema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      return { ok: false, output: `Invalid input for ${name}: ${detail}` };
    }

    const decision = this.decisionFor(t);
    if (decision === 'deny') {
      return { ok: false, output: `Tool ${name} is denied by config (permissions).` };
    }
    if (decision === 'confirm' && !ctx.isSessionApproved(name)) {
      const res = await ctx.approve({ tool: name, input: parsed.data });
      if (res.decision === 'deny') {
        return { ok: false, output: `User denied running ${name}.` };
      }
      if (res.scope === 'session') ctx.approveSession(name);
    }

    const started = Date.now();
    try {
      const result = await t.execute(parsed.data, ctx);
      log.info({ tool: name, ok: result.ok, ms: Date.now() - started }, 'tool dispatch');
      return result;
    } catch (e) {
      log.warn({ tool: name, err: (e as Error).message }, 'tool error');
      return { ok: false, output: `${name} failed: ${(e as Error).message}` };
    }
  }
}
```

### 5.8 `src/tools/fs/read.ts`

```ts
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { toInputSchema, type Tool } from '../types.js';

const MAX_LINES = 2000;
const MAX_BYTES = 100 * 1024;

const schema = z.object({
  path: z.string().min(1).describe('File path, relative to cwd or absolute'),
  offset: z.number().int().min(1).optional().describe('1-based start line, default 1'),
  limit: z.number().int().min(1).max(MAX_LINES).optional().describe('Max lines, default 2000'),
});

export const readFileTool: Tool<z.infer<typeof schema>> = {
  name: 'read_file',
  description:
    'Read a text file and return its content with 1-based line numbers. Use offset/limit to page through large files.',
  schema,
  inputSchema: toInputSchema(schema),
  isReadOnly: true,
  async execute(input, ctx) {
    const p = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    const st = await stat(p).catch(() => null);
    if (!st) return { ok: false, output: `File not found: ${input.path}` };
    if (st.isDirectory()) {
      return {
        ok: false,
        output: `${input.path} is a directory (directory listing arrives in Phase 2).`,
      };
    }
    const raw = await readFile(p, 'utf8');
    const lines = raw.split('\n');
    const offset = input.offset ?? 1;
    const limit = Math.min(input.limit ?? MAX_LINES, MAX_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    let out = slice.map((l, i) => `${offset + i}: ${l}`).join('\n');
    let byteCapped = false;
    if (out.length > MAX_BYTES) {
      out = out.slice(0, MAX_BYTES);
      byteCapped = true;
    }
    const end = offset + slice.length - 1;
    if (end < lines.length || byteCapped) {
      out += `\n[truncated: showing lines ${offset}-${end} of ${lines.length}${byteCapped ? ', byte-capped' : ''}]`;
    }
    return { ok: true, output: out, meta: { path: p, totalLines: lines.length } };
  },
};
```

### 5.9 `src/tools/edit/replace.ts`

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { toInputSchema, type Tool } from '../types.js';

const schema = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1).describe('Exact text to find; must match exactly one location'),
  new_string: z.string(),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace all occurrences instead of requiring unique match'),
});

export const replaceInFileTool: Tool<z.infer<typeof schema>> = {
  name: 'replace_in_file',
  description:
    'Replace an exact string in a file. Fails unless old_string matches exactly one location (use replace_all for multiple). Always read_file first to confirm the exact text.',
  schema,
  inputSchema: toInputSchema(schema),
  isReadOnly: false,
  async execute(input, ctx) {
    const p = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    const raw = await readFile(p, 'utf8').catch(() => null);
    if (raw === null) return { ok: false, output: `File not found: ${input.path}` };

    const count = raw.split(input.old_string).length - 1;
    if (count === 0) {
      return {
        ok: false,
        output: `old_string not found in ${input.path}. Re-read the file to get the exact current content.`,
      };
    }
    if (count > 1 && !input.replace_all) {
      return {
        ok: false,
        output: `old_string matches ${count} locations in ${input.path}; include more surrounding context to make it unique, or set replace_all=true.`,
      };
    }
    const next = input.replace_all
      ? raw.split(input.old_string).join(input.new_string)
      : raw.replace(input.old_string, input.new_string);
    await writeFile(p, next, 'utf8');
    const n = input.replace_all ? count : 1;
    return {
      ok: true,
      output: `Replaced ${n} occurrence(s) in ${input.path}.`,
      meta: { path: p, occurrences: n },
    };
  },
};
```

> 写前备份（`.kode/undo/`）按主计划属 Phase 2；Phase 1 依赖“编辑前已 read + 用户确认”双保险。dispatch 与工具写入前都要复查 `AbortSignal`，确保用户在确认期间取消后不会继续写文件。

### 5.10 `src/tools/shell/run.ts`

> 下方是核心流程示意。最终实现还必须满足：启动前检查已取消信号；POSIX 下创建并终止整个进程组；SIGTERM 5 秒后升级 SIGKILL；stdout/stderr 在接收过程中使用有界尾部缓冲，不能先无限累积再截断。对应回归测试覆盖预取消、后台子进程和高流量输出。

```ts
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { toInputSchema, type Tool, type ToolResult } from '../types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const TAIL_LINES = 2000;
const TAIL_BYTES = 50 * 1024;

const schema = z.object({
  command: z.string().min(1).describe('bash command line'),
  timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional(),
});

export const runCommandTool: Tool<z.infer<typeof schema>> = {
  name: 'run_command',
  description:
    'Run a bash command in the working directory. Returns exit code and truncated stdout/stderr (tail). Use for builds, tests, git status, etc.',
  schema,
  inputSchema: toInputSchema(schema),
  isReadOnly: false,
  execute(input, ctx) {
    const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    return new Promise<ToolResult>((resolvePromise) => {
      const child = spawn('bash', ['-c', input.command], { cwd: ctx.cwd });
      let stdout = '';
      let stderr = '';
      let killed = false;

      const killTimer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, timeout);

      const onAbort = () => {
        killed = true;
        child.kill('SIGTERM');
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('error', (e) => {
        clearTimeout(killTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolvePromise({ ok: false, output: `spawn failed: ${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(killTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        let body = stdout;
        if (stderr.trim()) body += `\n[stderr]\n${stderr}`;
        body = truncateTail(body, TAIL_LINES, TAIL_BYTES);
        if (killed) body += `\n[killed: timeout ${timeout}ms or aborted]`;
        resolvePromise({
          ok: code === 0 && !killed,
          output: `exit code: ${code ?? 'null'}\n${body}`,
        });
      });
    });
  },
};

/** 保留尾部（头部截断），因为报错通常在末尾 */
function truncateTail(s: string, maxLines: number, maxBytes: number): string {
  let out = s.length > maxBytes ? s.slice(-maxBytes) : s;
  const lines = out.split('\n');
  if (lines.length > maxLines) {
    out =
      `[truncated: showing last ${maxLines} of ${lines.length} lines]\n` +
      lines.slice(-maxLines).join('\n');
  }
  return out;
}
```

> Phase 1 假定 POSIX（`bash -c`）。Windows 分支（`cmd`/pwsh）按主计划风险表留到 Phase 7，本文 §10 跟踪。

### 5.11 `src/tools/index.ts`

```ts
import type { Permissions } from '../config/schema.js';
import { replaceInFileTool } from './edit/replace.js';
import { readFileTool } from './fs/read.js';
import { ToolRegistry } from './registry.js';
import { runCommandTool } from './shell/run.js';

export function createDefaultRegistry(permissions: Permissions = {}): ToolRegistry {
  const r = new ToolRegistry(permissions);
  r.register(readFileTool);
  r.register(replaceInFileTool);
  r.register(runCommandTool);
  return r;
}
```

### 5.12 `src/agent/types.ts`

```ts
import type { LLMMessage, LLMProvider } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext, ToolResult } from '../tools/types.js';

export const DEFAULT_MAX_STEPS = 25;
export const DEFAULT_CONTEXT_MESSAGES = 20;

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: ToolResult }
  | { type: 'step'; index: number }
  | { type: 'done'; reason: 'end_turn' | 'max_tokens' | 'max_steps' | 'aborted' };

export interface AgentRunOptions {
  provider: LLMProvider;
  registry: ToolRegistry;
  model: string;
  system: string;
  /** 活历史：loop 直接向其 push（调用方持有引用，用于多轮） */
  messages: LLMMessage[];
  maxSteps: number;
  contextMessages: number;
  ctx: ToolContext;
  maxTokens?: number;
  signal?: AbortSignal;
}
```

### 5.13 `src/agent/loop.ts`

```ts
import type { ContentBlock, ToolUseBlock } from '../llm/types.js';
import { trimMessages } from './context.js';
import type { AgentEvent, AgentRunOptions } from './types.js';

export async function* agentLoop(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
  const { provider, registry, ctx } = opts;
  const history = opts.messages;

  for (let step = 0; step < opts.maxSteps; step++) {
    if (opts.signal?.aborted) {
      yield { type: 'done', reason: 'aborted' };
      return;
    }
    yield { type: 'step', index: step };

    const view = trimMessages(history, opts.contextMessages);
    const blocks: ContentBlock[] = [];
    const toolUses: ToolUseBlock[] = [];
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';

    try {
      for await (const ev of provider.complete(view, {
        model: opts.model,
        system: opts.system,
        tools: registry.specs(),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })) {
        if (ev.type === 'text') {
          yield { type: 'text', delta: ev.delta };
          pushText(blocks, ev.delta);
        } else if (ev.type === 'tool_use') {
          const b: ToolUseBlock = { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input };
          blocks.push(b);
          toolUses.push(b);
        } else if (ev.type === 'stop') {
          stopReason = ev.reason;
        }
      }
    } catch (e) {
      if (opts.signal?.aborted || isAbortError(e)) {
        yield { type: 'done', reason: 'aborted' };
        return;
      }
      throw e;
    }

    if (opts.signal?.aborted) {
      yield { type: 'done', reason: 'aborted' };
      return;
    }
    history.push({ role: 'assistant', content: blocks });

    if (toolUses.length === 0) {
      yield { type: 'done', reason: stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn' };
      return;
    }

    // 顺序执行（并行调度留 Phase 5）
    const results: ContentBlock[] = [];
    for (const tu of toolUses) {
      yield { type: 'tool_call', name: tu.name, input: tu.input };
      const result = await registry.dispatch(tu.name, tu.input, ctx);
      yield { type: 'tool_result', name: tu.name, result };
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.output,
        is_error: !result.ok,
      });
    }
    history.push({ role: 'user', content: results });
  }
  yield { type: 'done', reason: 'max_steps' };
}

function pushText(blocks: ContentBlock[], delta: string): void {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') last.text += delta;
  else blocks.push({ type: 'text', text: delta });
}

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === 'AbortError' || e.constructor.name === 'APIUserAbortError')
  );
}
```

### 5.14 `src/agent/context.ts`

```ts
import type { LLMMessage } from '../llm/types.js';

/**
 * 滑动窗口：保留最近 keep 条消息。
 * 配对对齐：若窗口首条是携带 tool_result 的 user 消息，向前扩展至对应 assistant，
 * 避免 Anthropic “tool_result 无配对 tool_use” 报错（§6.4）。
 */
export function trimMessages(messages: LLMMessage[], keep: number): LLMMessage[] {
  if (messages.length <= keep) return messages;
  let start = messages.length - keep;
  while (start > 0 && hasToolResult(messages[start]!)) start--;
  return messages.slice(start);
}

function hasToolResult(m: LLMMessage): boolean {
  return Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
}
```

### 5.15 `src/agent/prompt.ts`

```ts
import type { ToolSpec } from '../llm/types.js';

export function buildSystemPrompt(opts: {
  cwd: string;
  platform: string;
  date: string;
  rules?: string[];
  tools: ToolSpec[];
}): string {
  const rules =
    opts.rules && opts.rules.length ? opts.rules.map((r) => `- ${r}`).join('\n') : 'None.';
  return `You are Kode, a coding agent running locally in the user's terminal.

# Environment
- Working directory: ${opts.cwd} (all relative paths resolve here)
- Platform: ${opts.platform}; shell: bash
- Date: ${opts.date}

# Tools
- read_file: read a text file with line numbers; use offset/limit to page large files.
- replace_in_file: exact string replacement; old_string must match exactly one location unless replace_all=true. Always read_file first.
- run_command: run a bash command; returns exit code and tail-truncated output. Use for builds/tests/verification.

# Workflow
1. Understand before acting: read files before editing them.
2. Make minimal, focused changes; never rewrite a whole file when a targeted replace suffices.
3. After changing code, verify with the project's own checks (build/test/lint/typecheck) via run_command when available.
4. Batch independent reads in a single step when possible.
5. Do not run destructive commands (rm -rf, git reset --hard, ...) unless the user explicitly asked.
6. Never commit or push unless the user explicitly asked.

# Output
Be concise. Your text streams to a terminal; markdown is fine, avoid dumping huge content.

# Project Rules
${rules}`;
}
```

### 5.16 `src/cli/session.ts`（示意骨架，实现时补全）

```ts
import { agentLoop } from '../agent/loop.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { DEFAULT_CONTEXT_MESSAGES, DEFAULT_MAX_STEPS } from '../agent/types.js';
import type { Config } from '../config/schema.js';
import type { LLMMessage, LLMProvider } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import { logger } from '../infra/logger.js';

export interface SessionDeps {
  provider: LLMProvider;
  registry: ToolRegistry;
  model: string;
  config: Config;
  cwd: string;
  /** 非交互模式（kode run --yes / 无 TTY）时提供 */
  autoApprove?: boolean;
}

export class TerminalSession {
  private history: LLMMessage[] = [];
  private sessionApproved = new Set<string>();
  private currentAbort: AbortController | null = null;
  private system: string;

  constructor(private deps: SessionDeps) {
    this.system = buildSystemPrompt({
      cwd: deps.cwd,
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
      ...(deps.config.rules ? { rules: deps.config.rules } : {}),
      tools: deps.registry.specs(),
    });
  }

  /** 中断当前轮；无在跑任务时返回 false（调用方据此退出） */
  interrupt(): boolean {
    if (this.currentAbort) {
      this.currentAbort.abort();
      return true;
    }
    return false;
  }

  private toolContext(signal: AbortSignal): ToolContext {
    return {
      cwd: this.deps.cwd,
      signal,
      approve: (req) => this.approve(req, signal),
      isSessionApproved: (n) => this.sessionApproved.has(n),
      approveSession: (n) => this.sessionApproved.add(n),
      logger,
    };
  }

  private async approve(req: { tool: string; input: unknown }, signal: AbortSignal) {
    if (signal.aborted) return { decision: 'deny' as const };
    if (this.deps.autoApprove) return { decision: 'allow' as const, scope: 'once' as const };
    // 行内确认（实现见 §6.3）：[y]es once / [a]lways session / [n]o
    // 用 readline question 读取；无 TTY 时默认 deny
    /* … */
    return { decision: 'deny' as const };
  }

  async runTurn(input: string): Promise<TurnResult> {
    this.history.push({ role: 'user', content: input });
    const ac = new AbortController();
    this.currentAbort = ac;
    let reason: AgentDoneReason = 'end_turn';
    try {
      for await (const ev of agentLoop({
        provider: this.deps.provider,
        registry: this.deps.registry,
        model: this.deps.model,
        system: this.system,
        messages: this.history,
        maxSteps: this.deps.config.agent?.maxSteps ?? DEFAULT_MAX_STEPS,
        contextMessages: this.deps.config.agent?.contextMessages ?? DEFAULT_CONTEXT_MESSAGES,
        ctx: this.toolContext(ac.signal),
        ...(this.deps.config.model?.maxTokens !== undefined
          ? { maxTokens: this.deps.config.model.maxTokens }
          : {}),
        signal: ac.signal,
      })) {
        switch (ev.type) {
          case 'text':
            process.stdout.write(ev.delta);
            break;
          case 'tool_call':
            process.stdout.write(`\n→ ${ev.name} ${summarizeInput(ev.name, ev.input)}\n`);
            break;
          case 'tool_result':
            process.stdout.write(
              ev.result.ok ? '  [ok]\n' : `  [error] ${firstLine(ev.result.output)}\n`,
            );
            break;
          case 'done':
            reason = ev.reason;
            if (ev.reason === 'aborted') process.stdout.write('\n[aborted]\n');
            if (ev.reason === 'max_steps') process.stdout.write('\n[stopped: max steps reached]\n');
            break;
        }
      }
      return { ok: reason !== 'aborted', reason };
    } catch (e) {
      logger.error({ err: e }, 'agent turn failed');
      process.stdout.write(`\n[error] ${(e as Error).message}\n`);
      return { ok: false, reason: 'error' };
    } finally {
      this.currentAbort = null;
      process.stdout.write('\n');
    }
  }
}

function summarizeInput(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const s =
    name === 'run_command' ? String(o.command ?? '') : String(o.path ?? JSON.stringify(input));
  return s.length > 100 ? s.slice(0, 100) + '…' : s;
}

function firstLine(s: string): string {
  return s.split('\n', 1)[0] ?? '';
}
```

### 5.17 `src/cli/commands/repl.ts`

```ts
import * as readline from 'node:readline';
import { findConfigFiles } from '../../config/find.js';
import { loadConfig } from '../../config/loader.js';
import { createProvider } from '../../llm/index.js';
import { createDefaultRegistry } from '../../tools/index.js';
import { TerminalSession } from '../session.js';
import { VERSION } from '../../version.js';

export async function startRepl(cwd: string): Promise<void> {
  const { config } = loadConfig(findConfigFiles(cwd));
  const { provider, model } = createProvider(config); // ProviderConfigError 由 CLI 顶层捕获 → 退出码 1
  const session = new TerminalSession({
    provider,
    registry: createDefaultRegistry(config.permissions ?? {}),
    model,
    config,
    cwd,
  });

  console.log(`kode ${VERSION} — ${model}. /help for commands, /exit to quit.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    if (!session.interrupt()) {
      rl.close();
      process.exit(130);
    }
  });

  // REPL 主循环（示意）：rl.question('> ')
  //   ''         → 继续
  //   /exit|/quit → break
  //   /help      → 打印命令
  //   /clear     → 清空历史（新增 session.clearHistory()）
  //   其他       → await session.runTurn(line)
  /* … */
  rl.close();
}
```

### 5.18 `src/cli/commands/run.ts` + `src/cli/index.ts`（接线）

```ts
// run.ts：与 REPL 共享 TerminalSession；仅 runTurn 一次后退出
export async function runOnce(
  cwd: string,
  prompt: string,
  opts: { yes?: boolean },
): Promise<number>;
// 无 TTY 且未 --yes 时 approve 一律 deny（结果回灌模型，模型会说明被拦截）
// runTurn error → 1；aborted → 130；正常结束（含 max token/step）→ 0

// cli/index.ts 增量：
program
  .command('repl')
  .description('Start interactive REPL')
  .action(() => startRepl(process.cwd()));

program
  .command('run')
  .argument('<prompt>', 'One-shot prompt')
  .option('-y, --yes', 'Auto-approve all tool confirmations')
  .description('Run a single prompt non-interactively')
  .action(async (prompt: string, o: { yes?: boolean }) => {
    process.exitCode = await runOnce(process.cwd(), prompt, o);
  });

// 裸 `kode` ≡ `kode repl`：
program.action(() => startRepl(process.cwd()));
```

### 5.19 `tests/unit/agent-loop.test.ts`（核心单测，示意）

```ts
import { describe, expect, it } from 'vitest';
import { agentLoop } from '../../src/agent/loop.js';
import type { LLMMessage, LLMProvider, StreamEvent } from '../../src/llm/types.js';

class MockProvider implements LLMProvider {
  constructor(private script: StreamEvent[][]) {}
  complete(): AsyncIterable<StreamEvent> {
    const turn = this.script.shift() ?? [{ type: 'stop', reason: 'end_turn' } as const];
    return (async function* () {
      for (const e of turn) yield e;
    })();
  }
  countTokens(): number {
    return 0;
  }
  modelInfo() {
    return { maxTokens: 1, supportsToolUse: true };
  }
}

describe('agentLoop', () => {
  it('ends on pure text turn', async () => {
    // script: [text deltas + stop] → 期望事件序列 text*→done(end_turn)，history +2 条
  });

  it('dispatches tool_use, appends result, continues to next turn', async () => {
    // turn1: tool_use(read_file) + stop(tool_use)
    // turn2: text + stop
    // mock registry（或真 registry + mock tool）断言 dispatch 入参；
    // 断言 history 顺序：user → assistant(blocks) → user(tool_result) → assistant
  });

  it('stops at maxSteps with done(max_steps)', async () => {
    // script 每轮都给 tool_use；maxSteps=2 → done(max_steps)
  });

  it('aborts gracefully', async () => {
    // signal 预先 abort → 首事件 done(aborted)
  });
});
```

> 其余单测：`llm-convert`（system 抽出、block 映射、tool role string 抛错）、`agent-context`（窗口不截断/截断/tool 配对对齐）、`tools-registry`（未知工具、zod 报错、deny、confirm→approve→session 跳过）、三工具各配 tmpdir fixture（读分页/截断；替换唯一/多次/零匹配/写回验证；run 退出码/stderr/超时 kill/abort kill）。

### 5.20 `docs/examples/kode.jsonc`（更新）

```jsonc
{
  "version": 1,
  "model": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
  },
  "agent": {
    "maxSteps": 25,
    "contextMessages": 20,
  },
  "permissions": {
    "default": "confirm",
    "overrides": {
      "read_file": "allow",
    },
  },
  "rules": ["Always run `pnpm typecheck` after edits.", "Never edit files under dist/."],
  "logLevel": "info",
}
```

> 工具名从 Phase 0 占位的 `fs.read` 等命名空间式改为实际工具名（`read_file`）；命名空间留待工具增多后再引入。

## 6. 关键实现设计说明

### 6.1 流式 tool_use 解析策略（主计划标注的难点）

- Anthropic 将工具入参作为 `input_json_delta` 分片推送。**文本增量直发 UI，工具入参一律缓冲**到 `content_block_stop`，拼完整 JSON 后 `JSON.parse`，以单个 `tool_use` StreamEvent 上抛。
- 理由：agent loop 消费的是“完整工具调用”，增量入参无消费方；缓冲实现简单且无损（UI 只展示文本流 + 工具开始行）。
- 失败兜底：JSON 解析失败 → 以 `{}` 上抛 → 工具 zod 校验报错 → 作为 `tool_result(is_error)` 回灌模型，模型自愈重试，不崩 loop。

### 6.2 消息模型与 Anthropic 映射

- 内部模型沿用主计划 §6；**system 不进 messages**，由 `CompleteOptions.system` 独立传递（Anthropic API 形态如此；未来 OpenAI provider 在自家 convert 里把它塞回首条即可，接口不变）。
- `role:'tool'` 内部不产生：loop 把工具结果追加为 `user` 消息 + `ToolResultBlock[]`；convert 对 string 内容的 tool 消息直接抛错（防御）。
- assistant 文本增量合并为连续 TextBlock，tool_use 按序追加——保证回放/持久化（Phase 6）时消息即所见。
- 交替约束（user/assistant 严格交替、tool_use/tool_result 配对）由 loop 追加顺序天然满足。

### 6.3 最小确认门（提前落地的 M06 子集）

- 决策来源（优先级高→低）：`permissions.overrides[tool]` → 只读工具 `allow` → `permissions.default` → 内置默认 `confirm`。
- `confirm` 且非 session 已批 → `ctx.approve()`：REPL 行内询问 `Allow run_command? [y]es/[a]lways/[n]o`；`a` 记入 session 集合（按工具名）。
- `kode run --yes`：`autoApprove` 短路；无 TTY 且未 `--yes` 一律 deny（不挂起等待输入）。
- 审计落盘、策略表、路径级粒度按主计划归 Phase 2；本阶段 dispatch 已有结构化日志（tool/ok/ms），Phase 2 原地增强。

### 6.4 上下文滑动窗口（“简单 ABI 预算”的具体化）

- 规则：`resolve = trimMessages(history, contextMessages)`，默认保留最近 20 条；system 独立传递不占窗口。
- **provider 对齐**：若切口落在 assistant/tool 消息或含 `tool_result` 的 user 消息，向前扩展至真正的 user turn；连续工具链可能因此超过 20 条，保证请求不以 assistant 开头且 tool_use/tool_result 不被拆散。
- 该实现即主计划 Phase 1 的“固定保留最近 20 条消息”；Phase 3 以 token 预算器替换本函数，loop 调用点不变。

### 6.5 中断语义（主计划标注的难点）

- 每轮 turn 一个 `AbortController`；信号同时传给：SDK 请求、确认提示、tool dispatch、写工具、`run_command` 进程组和重试退避。
- Ctrl-C 两级：运行中 → abort 当前轮（loop 产 `done(aborted)`，回到提示符）；空闲 → 退出（码 130）。
- 子进程清理：POSIX 下独立进程组，超时/abort 对进程组发 SIGTERM，5s 后 SIGKILL 兜底；`close` 事件统一收口，不留后台子进程（验收用例 11 验证）。
- `finally` 保证 `currentAbort` 复位与换行输出，终端不残留半行。

### 6.6 重试与错误分层

- 仅**建连阶段**重试：HTTP 408/409/429/5xx/529，指数退避（1s/2s/4s + 抖动），最多重试 3 次（首次 + 重试共最多 4 次请求），可被 abort 打断。Anthropic/OpenAI SDK 的内置重试设为 0，避免重试层叠。
- **流中途错误** Phase 1 不重试（部分文本已渲染，重放会重复输出）：上抛 → session 捕获 → `[error] …` + 日志，用户可重发。断线恢复留 Phase 3+。
- 工具执行异常一律不外抛：dispatch 捕获 → `ToolResult{ok:false}` 回灌模型。

### 6.7 token 计数兜底

- `countTokens` = chars/4 估算，接口先立，Phase 1 不进关键路径；真实计数与预算日志（provider API / tokenizer）Phase 3 接入。

### 6.8 错误处理与退出码（沿用 Phase 0 表并增补）

| 场景                                        | 退出码          | 输出                                |
| ------------------------------------------- | --------------- | ----------------------------------- |
| 未配置 model / provider 不支持 / 缺 API key | `1`             | ProviderConfigError 友好文案 + 指引 |
| `kode run` 轮内 LLM/工具异常                | `1`             | `[error] …`（REPL 内不退出仅提示）  |
| `kode run` 运行中 Ctrl-C                    | `130`           | `[aborted]`                         |
| 其余                                        | 同 Phase 0 §6.5 |                                     |

### 6.9 可观测

- `llm` 组件：debug 记 model/消息数/重试；**不记 prompt 全文与密钥**。
- `tools` 组件：info 记每次 dispatch（name/ok/耗时）；input 摘要在 Phase 2 审计时补。
- 终端输出与日志完全分离（日志仍只落 `~/.kode/logs/`）。

## 7. 开发工作流（命令清单）

```bash
pnpm add @anthropic-ai/sdk openai zod-to-json-schema  # 新增运行时依赖
export ANTHROPIC_API_KEY=sk-...                    # 或写入 .env（勿提交）
pnpm dev                                           # ≡ kode repl（源码直跑）
pnpm dev -- run "read package.json and summarize"  # 一次性（非只读工具会被 deny）
pnpm dev -- run "..." --yes                        # 一次性 + 自动放行
pnpm dev -- config                                 # 验证配置（Phase 0 能力回归）
KODE_LOG_LEVEL=debug pnpm dev                      # 观察 llm/tools 结构化日志
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check   # 一致性闸门
```

## 8. 验收用例（acceptance）

> 1–6 为自动/半自动；7–13 为人工走查（需真实 API key）。执行顺序即编号顺序。

1. **闸门四绿** — `pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm format:check` 全部 0 退出码。
2. **单测覆盖** — §5.19 所列 loop 4 用例 + convert/context/registry/三工具用例全绿；测试中**零真实 API 调用**（mock provider）。
3. **缺配置报错** — 无 `kode.jsonc`（或缺 `model` 段）时 `kode repl` → 退出码 1，文案指引配置示例。
4. **缺 key 报错** — 配置完整但 `ANTHROPIC_API_KEY` 未设 → 退出码 1，文案含变量名。
5. **非 TTY deny** — `echo` 管道喂 `kode run`（无 `--yes`）一个需写文件的任务 → 写工具被 deny 且结果回灌模型，进程正常结束。
6. **回归** — `kode --version`、`kode config` 行为与 Phase 0 验收一致。
7. **流式可见** — REPL 中提问，文本**逐段**出现而非整段落地。
8. **主验收任务** — 在一个**临时副本**仓库执行：“读 README，加一节 Installation（内容为 pnpm install），并运行 `node -v` 确认输出” → agent 依次 `read_file` →（确认 y）`replace_in_file` →（确认 y）`run_command` → 总结；README 实际被改、命令输出含 node 版本。
9. **session 放权** — 同会话中第二次写操作前选 `a` → 后续同类工具不再询问。
10. **拒绝路径** — 对编辑确认答 `n` → 模型收到 denial 并改用说明回应；目标文件**未变**。
11. **Ctrl-C 清理** — 让 agent 跑 `sleep 30` 后按 Ctrl-C → 立即回到提示符，`ps` 无残留 `sleep` 进程；再按 Ctrl-C 退出码 130。
12. **多轮记忆** — 紧接问“刚才改了哪个文件？” → 回答正确（历史生效）。
13. **日志** — debug 级别下日志含 `llm request`、`tool dispatch` 行，且**不含** API key。

## 9. 验收 Checklist

- [ ] T01–T18 全部完成
- [ ] §8 用例 1–13 全部通过
- [ ] 三工具声明式注册，zod schema 与注入 LLM 的 JSON Schema 同源
- [ ] 非只读工具默认 confirm，once/session 放权生效，`--yes` 生效且有警示
- [ ] 滑动窗口 + tool 配对对齐有单测
- [ ] Ctrl-C 两级语义与退出码 130 验证通过
- [ ] loop 对 mock provider 可回放（4 用例）
- [ ] 缺 model/缺 key 友好报错（退出码 1）
- [ ] `pnpm build` 后 `node dist/index.js repl` 同样可用（构建产物回归）
- [ ] `AGENTS.md` 与 `docs/examples/kode.jsonc` 已同步
- [ ] §12 差异已备注，主计划无需立刻修改项已列出

## 10. 风险与缓解

| 风险                                                  | 触发                      | 缓解                                                               |
| ----------------------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| partial JSON 解析失败                                 | 流式 tool_use 分片异常    | 缓冲到 block_stop；失败 → `{}` → zod 报错回灌模型自愈（§6.1）      |
| Ctrl-C 残留子进程                                     | run_command 长任务被中断  | 独立进程组；abort→SIGTERM→5s SIGKILL；验收用例 11 验证             |
| 窗口截断破坏 tool 配对                                | 历史 >20 条且切口在结果处 | trimMessages 向前对齐（§6.4）+ 单测                                |
| 429/529 限流风暴                                      | 高频多步任务              | 单层建连重试（最多 3 次）+ 退避；失败友好上浮（§6.6）              |
| `exactOptionalPropertyTypes` 与 SDK optional 字段冲突 | typecheck                 | 条件展开（`...(x ? {x} : {})`）已贯穿示例代码                      |
| 大文件/大输出撑爆上下文                               | read 大文件、命令刷屏     | 行数/字节双截断（read 头部截、run 尾部截）；token 预算 Phase 3     |
| `--yes` 误用致误执行                                  | 脚本环境自动放行          | 默认关；文档与 --help 标警示；无 TTY 默认 deny                     |
| Anthropic 消息交替约束报错                            | 异常路径历史错位          | loop 追加顺序保证；convert 防御性抛错 + 日志                       |
| 模型名过时或漏配                                      | 模型迭代/首次配置         | 不设隐式默认；schema 与 ProviderConfigError 给出明确提示           |
| Windows 无 bash                                       | Windows 用户              | Phase 1 声明 POSIX-only；cmd/pwsh 分支 Phase 7（主计划风险表同步） |
| SDK 类型导出路径漂移                                  | 升级 SDK                  | 命名空间类型引用 + typecheck 闸门；升级时单点修 import             |

## 11. 工时预估与里程碑

- **总工时**：≈ 31–32h（4 个工作日）
- **关键路径**：T01 → T02 → T03 → T04 → T05 → T15 → T18
- **Day 1**（~8h）：T01–T06（依赖、llm 类型、convert、provider、工厂、registry）
- **Day 2**（~7h）：T07–T10 三工具 + T16 工具单测先行
- **Day 3**（~8h）：T11–T13（loop/context/prompt）+ loop 单测
- **Day 4**（~8h）：T14–T15（session/REPL/run）、T16 补全、T17 文档、T18 验收
- **里程碑 M1**：§8 用例 1–13 全绿 → 达成主计划「M1（MVP 起点）」，解锁 Phase 2。

## 12. 与主计划的差异备注

| 项                | 主计划                             | 本阶段修订                                                                                                                                                                                     |
| ----------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “简单 ABI 预算”   | 表述为固定保留最近 20 条消息       | 具体化为滑动窗口 `trimMessages` + tool 配对对齐（§6.4）                                                                                                                                        |
| `CompleteOptions` | 无 `system` 字段                   | 增加 `system?: string`（Anthropic system 独立参数；接口对未来 provider 仍通用）                                                                                                                |
| `ToolContext`     | `abort: AbortSignal`               | 更名 `signal`（对齐 AbortSignal 惯例）；增 `isSessionApproved/approveSession`                                                                                                                  |
| `ApprovalResult`  | `decision: Decision`（含 confirm） | 收敛为 `'allow' \| 'deny'`（confirm 是决策非结果）；scope 保留                                                                                                                                 |
| 权限门            | Phase 2 交付                       | 最小子集（config 决策 + 行内 approve + session 放权）提前到 Phase 1（§6.3）                                                                                                                    |
| 交互形态          | 仅 REPL                            | 增 `kode run "<prompt>" [--yes]`（one-shot，便于验收/脚本化）                                                                                                                                  |
| 工具入参校验      | `inputSchema: JSONSchema` 手写     | zod 单一来源 + zod-to-json-schema 派生（新依赖）                                                                                                                                               |
| 工具命名          | 示例含 `fs.read` 命名空间          | Phase 1 用扁平名 `read_file/replace_in_file/run_command`；命名空间延后                                                                                                                         |
| provider          | Anthropic/OpenAI 并举              | 按用户决策：Phase 1 即支持双协议（anthropic 直连 + openai/local 走 OpenAI 兼容），`baseURL`/`model`/`apiKey` 均可配；apiKey 解析顺序：配置直写 → `apiKeyEnv` 指定 env → provider 默认 env 变量 |

> 上述差异中，接口字段调整（system/signal/ApprovalResult）建议在 Phase 1 收尾时回写主计划 §6，保持索引一致。
