import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentLoop } from '../../src/agent/loop.js';
import type { AgentEvent, AgentRunOptions } from '../../src/agent/types.js';
import { ContextManager } from '../../src/context/manager.js';
import type { TokenCounter } from '../../src/context/counter.js';
import type { Summarizer } from '../../src/context/summarize.js';
import type {
  CompleteOptions,
  LLMMessage,
  LLMProvider,
  ModelInfo,
  StreamEvent,
} from '../../src/llm/types.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { toInputSchema, type Tool, type ToolContext } from '../../src/tools/types.js';
import { testLogger } from './helpers.js';

class MockProvider implements LLMProvider {
  calls: LLMMessage[][] = [];
  constructor(private script: StreamEvent[][]) {}
  complete(messages: LLMMessage[], _opts: CompleteOptions): AsyncIterable<StreamEvent> {
    this.calls.push([...messages]);
    const turn = this.script.shift() ?? [{ type: 'stop', reason: 'end_turn' } as const];
    return (async function* () {
      for (const e of turn) yield e;
    })();
  }
  async countTokens(): Promise<number> {
    return 0;
  }
  modelInfo(): ModelInfo {
    return { contextWindowTokens: 128_000, supportsToolUse: true };
  }
}

const echoSchema = z.object({ text: z.string() });
const echoTool: Tool<z.infer<typeof echoSchema>> = {
  name: 'echo',
  description: 'Echo text back',
  schema: echoSchema,
  inputSchema: toInputSchema(echoSchema),
  isReadOnly: true,
  async execute(input) {
    return { ok: true, output: input.text };
  },
};

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'kode-loop-test-'));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function mockCtx(): ToolContext {
  return {
    cwd: workdir,
    signal: new AbortController().signal,
    approve: async () => ({ decision: 'allow', scope: 'once' }),
    isSessionApproved: () => false,
    approveSession: () => {},
    logger: testLogger,
  };
}

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(echoTool);
  return r;
}

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function baseOpts(provider: LLMProvider, messages: LLMMessage[]): AgentRunOptions {
  return {
    provider,
    registry: registry(),
    model: 'mock',
    system: 'sys',
    messages,
    maxSteps: 10,
    contextManager: new ContextManager({
      provider,
      context: { windowTokens: 128_000, safetyReserveTokens: 0 },
    }),
    maxTokens: 1024,
    ctx: mockCtx(),
  };
}

describe('agentLoop', () => {
  it('ends a pure text turn with done(end_turn) and merged text', async () => {
    const provider = new MockProvider([
      [
        { type: 'text', delta: 'Hel' },
        { type: 'text', delta: 'lo' },
        { type: 'stop', reason: 'end_turn' },
      ],
    ]);
    const history: LLMMessage[] = [{ role: 'user', content: 'hi' }];
    const events = await collect(agentLoop(baseOpts(provider, history)));

    expect(events.map((e) => e.type)).toEqual(['step', 'context', 'text', 'text', 'done']);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'end_turn' });
    expect(history.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
    });
  });

  it('dispatches tool_use, appends tool_result, and continues', async () => {
    const provider = new MockProvider([
      [
        { type: 'tool_use', id: 't1', name: 'echo', input: { text: 'ping' } },
        { type: 'stop', reason: 'tool_use' },
      ],
      [
        { type: 'text', delta: 'done' },
        { type: 'stop', reason: 'end_turn' },
      ],
    ]);
    const history: LLMMessage[] = [{ role: 'user', content: 'go' }];
    const events = await collect(agentLoop(baseOpts(provider, history)));

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'step',
      'context',
      'tool_call',
      'tool_result',
      'step',
      'context',
      'text',
      'done',
    ]);
    const tr = events.find((e) => e.type === 'tool_result');
    expect(tr).toMatchObject({ name: 'echo', result: { ok: true, output: 'ping' } });

    // history: user → assistant(tool_use) → user(tool_result) → assistant(text)
    expect(history).toHaveLength(4);
    expect(history[1]?.role).toBe('assistant');
    expect(history[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ping', is_error: false }],
    });
    // second LLM call saw the tool_result in its messages
    expect(provider.calls[1]?.at(-1)).toEqual(history[2]);
  });

  it('marks tool errors as is_error tool_result and keeps going', async () => {
    const provider = new MockProvider([
      [
        { type: 'tool_use', id: 't1', name: 'nope', input: {} },
        { type: 'stop', reason: 'tool_use' },
      ],
      [
        { type: 'text', delta: 'recovered' },
        { type: 'stop', reason: 'end_turn' },
      ],
    ]);
    const history: LLMMessage[] = [{ role: 'user', content: 'go' }];
    await collect(agentLoop(baseOpts(provider, history)));
    expect(history[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }],
    });
  });

  it('stops at maxSteps with done(max_steps)', async () => {
    const turn: StreamEvent[] = [
      { type: 'tool_use', id: 'x', name: 'echo', input: { text: 'loop' } },
      { type: 'stop', reason: 'tool_use' },
    ];
    const provider = new MockProvider([turn, turn, turn]);
    const history: LLMMessage[] = [{ role: 'user', content: 'go' }];
    const events = await collect(agentLoop({ ...baseOpts(provider, history), maxSteps: 2 }));
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'max_steps' });
  });

  it('aborts gracefully when the signal is already aborted', async () => {
    const provider = new MockProvider([]);
    const ac = new AbortController();
    ac.abort();
    const history: LLMMessage[] = [{ role: 'user', content: 'go' }];
    const events = await collect(agentLoop({ ...baseOpts(provider, history), signal: ac.signal }));
    expect(events).toEqual([{ type: 'done', reason: 'aborted' }]);
    expect(provider.calls).toHaveLength(0);
  });

  it('treats an SDK APIUserAbortError as a graceful abort', async () => {
    class APIUserAbortError extends Error {}
    const provider: LLMProvider = {
      async *complete() {
        throw new APIUserAbortError('Request was aborted');
      },
      countTokens: async () => 0,
      modelInfo: () => ({ contextWindowTokens: 128_000, supportsToolUse: true }),
    };
    const history: LLMMessage[] = [{ role: 'user', content: 'go' }];
    const events = await collect(agentLoop(baseOpts(provider, history)));
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'aborted' });
  });

  it('keeps every provider request in budget across 30 tool calls', async () => {
    const script: StreamEvent[][] = [];
    for (let index = 0; index < 30; index++) {
      script.push([
        {
          type: 'tool_use',
          id: `t${index}`,
          name: 'echo',
          input: { text: `result-${index}` },
        },
        { type: 'stop', reason: 'tool_use' },
      ]);
    }
    script.push([
      { type: 'text', delta: 'complete' },
      { type: 'stop', reason: 'end_turn' },
    ]);
    const provider = new MockProvider(script);
    const counter: TokenCounter = {
      count: async (request) => ({
        tokens: request.messages.length * 100,
        accuracy: 'tokenizer',
        source: 'test',
      }),
    };
    const summarizer: Summarizer = {
      summarize: async () => ({
        source: 'llm',
        text: [
          'Goal',
          'task',
          'Constraints',
          'rules',
          'Decisions',
          'none',
          'Files and edits',
          'none',
          'Commands and verification',
          'none',
          'Errors and rejected approaches',
          'none',
          'Open work',
          'continue',
        ].join('\n'),
      }),
    };
    const contextManager = new ContextManager({
      provider,
      counter,
      summarizer,
      context: {
        windowTokens: 1000,
        safetyReserveTokens: 0,
        minimumOutputTokens: 50,
        preserveRecentTurns: 3,
        toolResultTokens: 1000,
      },
    });
    const history: LLMMessage[] = [{ role: 'user', content: 'run the long task' }];
    const events = await collect(
      agentLoop({
        ...baseOpts(provider, history),
        contextManager,
        maxTokens: 100,
        maxSteps: 31,
      }),
    );

    expect(events.at(-1)).toEqual({ type: 'done', reason: 'end_turn' });
    expect(provider.calls).toHaveLength(31);
    expect(provider.calls.every((messages) => messages.length * 100 <= 900)).toBe(true);
    expect(history).toHaveLength(62);
  });
});
