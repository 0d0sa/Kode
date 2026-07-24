import { describe, expect, it } from 'vitest';
import { HistorySummarizer } from '../../src/context/summarize.js';
import type {
  CompleteOptions,
  LLMMessage,
  LLMProvider,
  ModelInfo,
  StreamEvent,
} from '../../src/llm/types.js';

class SummaryProvider implements LLMProvider {
  lastOptions: CompleteOptions | undefined;

  constructor(private readonly events: StreamEvent[] | Error) {}

  complete(_messages: LLMMessage[], opts: CompleteOptions): AsyncIterable<StreamEvent> {
    this.lastOptions = opts;
    const events = this.events;
    return (async function* () {
      if (events instanceof Error) throw events;
      for (const event of events) yield event;
    })();
  }

  modelInfo(): ModelInfo {
    return { contextWindowTokens: 1000, supportsToolUse: true };
  }
}

describe('HistorySummarizer', () => {
  it('disables tools and deterministically falls back on invalid output', async () => {
    const provider = new SummaryProvider([
      { type: 'text', delta: 'free-form invalid summary' },
      { type: 'stop', reason: 'end_turn' },
    ]);
    const summarizer = new HistorySummarizer(provider, 'mock');
    const result = await summarizer.summarize(
      [{ role: 'user', content: 'do not leak this into logs' }],
      undefined,
      500,
      128,
    );
    expect(result.source).toBe('fallback');
    expect(result.text).toContain('Goal');
    expect(result.text).toContain('Open work');
    expect(provider.lastOptions?.tools).toEqual([]);
  });

  it('propagates Abort instead of creating a fallback summary', async () => {
    class APIUserAbortError extends Error {}
    const provider = new SummaryProvider(new APIUserAbortError('aborted'));
    const summarizer = new HistorySummarizer(provider, 'mock');
    await expect(
      summarizer.summarize([{ role: 'user', content: 'task' }], undefined, 500, 128),
    ).rejects.toMatchObject({ message: 'aborted' });
  });
});
