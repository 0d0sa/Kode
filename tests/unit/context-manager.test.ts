import { describe, expect, it } from 'vitest';
import { compactToolResults } from '../../src/context/compact-tools.js';
import type { TokenCounter } from '../../src/context/counter.js';
import { ContextBudgetError } from '../../src/context/errors.js';
import { ContextManager } from '../../src/context/manager.js';
import type { Summarizer, SummaryResult } from '../../src/context/summarize.js';
import type {
  CompleteOptions,
  LLMMessage,
  LLMProvider,
  ModelInfo,
  StreamEvent,
  TokenCount,
  TokenCountRequest,
} from '../../src/llm/types.js';

class EmptyProvider implements LLMProvider {
  async *complete(_messages: LLMMessage[], _opts: CompleteOptions): AsyncIterable<StreamEvent> {}
  modelInfo(): ModelInfo {
    return { contextWindowTokens: 1000, supportsToolUse: true };
  }
}

class MessageCounter implements TokenCounter {
  async count(request: TokenCountRequest): Promise<TokenCount> {
    return {
      tokens: request.messages.length * 100,
      accuracy: 'tokenizer',
      source: 'test',
    };
  }
}

class FixedCounter implements TokenCounter {
  constructor(private readonly tokens: number) {}
  async count(): Promise<TokenCount> {
    return { tokens: this.tokens, accuracy: 'tokenizer', source: 'test' };
  }
}

class FixedSummarizer implements Summarizer {
  calls = 0;
  async summarize(): Promise<SummaryResult> {
    this.calls++;
    return {
      source: 'llm',
      text: [
        'Goal',
        'keep going',
        'Constraints',
        'keep root',
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
    };
  }
}

class AbortOnceSummarizer extends FixedSummarizer {
  override async summarize(): Promise<SummaryResult> {
    this.calls++;
    if (this.calls === 1) throw new DOMException('Aborted', 'AbortError');
    return {
      source: 'llm',
      text: [
        'Goal',
        'continue',
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
    };
  }
}

const provider = new EmptyProvider();
const requestBase = {
  model: 'mock',
  system: 'system rules',
  tools: [],
  requestedOutputTokens: 100,
};

function toolHistory(count: number): LLMMessage[] {
  const messages: LLMMessage[] = [{ role: 'user', content: 'original root task' }];
  for (let index = 0; index < count; index++) {
    const id = `t${index}`;
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'echo', input: { index } }],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: `result-${index}` }],
    });
  }
  return messages;
}

describe('ContextManager', () => {
  it('passes a request through without summarizing when it fits', async () => {
    const summary = new FixedSummarizer();
    const manager = new ContextManager({
      provider,
      counter: new MessageCounter(),
      summarizer: summary,
      context: {
        windowTokens: 1000,
        safetyReserveTokens: 0,
        minimumOutputTokens: 50,
      },
    });
    const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }];
    const resolution = await manager.resolve({ ...requestBase, messages });
    expect(resolution.messages).toEqual(messages);
    expect(resolution.report.actions).toEqual([]);
    expect(JSON.stringify(resolution.report)).not.toContain('hello');
    expect(summary.calls).toBe(0);
  });

  it('summarizes old complete step groups, preserves root text, and reuses checkpoint', async () => {
    const summary = new FixedSummarizer();
    const manager = new ContextManager({
      provider,
      counter: new MessageCounter(),
      summarizer: summary,
      context: {
        windowTokens: 900,
        safetyReserveTokens: 0,
        minimumOutputTokens: 50,
        preserveRecentTurns: 2,
        toolResultTokens: 1000,
      },
    });
    const messages = toolHistory(5);
    const first = await manager.resolve({ ...requestBase, messages });
    expect(summary.calls).toBe(1);
    expect(first.report.actions.map((action) => action.kind)).toContain('summarize_turns');
    expect(JSON.stringify(first.messages[0])).toContain('original root task');
    expect(first.messages.length).toBeLessThan(messages.length);
    expect(messages).toHaveLength(11);

    const next = [...messages, ...toolHistory(1).slice(1)];
    const second = await manager.resolve({ ...requestBase, messages: next });
    expect(summary.calls).toBe(1);
    expect(second.report.checkpointReused).toBe(true);
    expect(second.report.usage.totalInputTokens).toBeLessThanOrEqual(
      second.report.budget.inputLimitTokens,
    );

    const later = [...next, ...toolHistory(5).slice(1)];
    const third = await manager.resolve({ ...requestBase, messages: later });
    expect(summary.calls).toBe(2);
    expect(third.report.actions.map((action) => action.kind)).toContain('summarize_turns');
    expect(JSON.stringify(third.messages[0])).toContain('original root task');
    expect(third.report.usage.totalInputTokens).toBeLessThanOrEqual(
      third.report.budget.inputLimitTokens,
    );
  });

  it('handles a 30-step tool chain without splitting retained tool pairs', async () => {
    const manager = new ContextManager({
      provider,
      counter: new MessageCounter(),
      summarizer: new FixedSummarizer(),
      context: {
        windowTokens: 1000,
        safetyReserveTokens: 0,
        minimumOutputTokens: 50,
        preserveRecentTurns: 3,
        toolResultTokens: 1000,
      },
    });
    const resolution = await manager.resolve({
      ...requestBase,
      messages: toolHistory(30),
    });
    expect(resolution.report.usage.totalInputTokens).toBeLessThanOrEqual(
      resolution.report.budget.inputLimitTokens,
    );
    for (let index = 1; index < resolution.messages.length; index += 2) {
      const assistant = resolution.messages[index];
      const result = resolution.messages[index + 1];
      if (!assistant || !result) continue;
      const use =
        Array.isArray(assistant.content) &&
        assistant.content.find((block) => block.type === 'tool_use');
      const toolResult =
        Array.isArray(result.content) &&
        result.content.find((block) => block.type === 'tool_result');
      if (use && toolResult) expect(toolResult.tool_use_id).toBe(use.id);
    }
  });

  it('reduces the output reserve before failing required-only context', async () => {
    const manager = new ContextManager({
      provider,
      counter: new FixedCounter(850),
      context: {
        windowTokens: 1000,
        safetyReserveTokens: 0,
        minimumOutputTokens: 100,
      },
    });
    const resolution = await manager.resolve({
      ...requestBase,
      requestedOutputTokens: 200,
      messages: [{ role: 'user', content: 'required' }],
    });
    expect(resolution.maxOutputTokens).toBe(150);
    expect(resolution.report.actions.at(-1)?.kind).toBe('reduce_output_reserve');

    const failing = new ContextManager({
      provider,
      counter: new FixedCounter(950),
      context: {
        windowTokens: 1000,
        safetyReserveTokens: 0,
        minimumOutputTokens: 100,
      },
    });
    await expect(
      failing.resolve({
        ...requestBase,
        requestedOutputTokens: 200,
        messages: [{ role: 'user', content: 'required' }],
      }),
    ).rejects.toBeInstanceOf(ContextBudgetError);
  });

  it('does not publish a partial checkpoint when summary is aborted', async () => {
    const summarizer = new AbortOnceSummarizer();
    const manager = new ContextManager({
      provider,
      counter: new MessageCounter(),
      summarizer,
      context: {
        windowTokens: 900,
        safetyReserveTokens: 0,
        minimumOutputTokens: 50,
        preserveRecentTurns: 2,
        toolResultTokens: 1000,
      },
    });
    const request = { ...requestBase, messages: toolHistory(5) };
    await expect(manager.resolve(request)).rejects.toMatchObject({ name: 'AbortError' });
    const recovered = await manager.resolve(request);
    expect(summarizer.calls).toBe(2);
    expect(recovered.report.checkpointReused).toBe(false);
    expect(recovered.report.actions.map((action) => action.kind)).toContain('summarize_turns');
  });
});

describe('compactToolResults', () => {
  it('keeps pairing, status, metadata, and head/tail without mutating raw history', () => {
    const raw: LLMMessage[] = [
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: `HEAD${'x'.repeat(1000)}TAIL`,
            is_error: false,
          },
        ],
      },
    ];
    const before = JSON.stringify(raw);
    const compacted = compactToolResults(
      raw,
      new Map([
        [
          't1',
          {
            name: 'read_file',
            input: { path: 'a.ts' },
            ok: true,
            meta: { sha256: 'abc', path: 'a.ts' },
          },
        ],
      ]),
      50,
    );
    expect(compacted.affectedMessages).toBe(1);
    expect(JSON.stringify(compacted.messages)).toContain('[context-compacted]');
    expect(JSON.stringify(compacted.messages)).toContain('sha256');
    expect(JSON.stringify(compacted.messages)).toContain('t1');
    expect(JSON.stringify(raw)).toBe(before);
  });
});
