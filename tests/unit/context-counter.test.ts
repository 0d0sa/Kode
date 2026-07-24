import { describe, expect, it } from 'vitest';
import {
  countLocalRequestTokens,
  RequestTokenCounter,
  tokenizeText,
} from '../../src/context/counter.js';
import type {
  CompleteOptions,
  LLMMessage,
  LLMProvider,
  ModelInfo,
  StreamEvent,
  TokenCountRequest,
} from '../../src/llm/types.js';

const request: TokenCountRequest = {
  model: 'mock',
  system: 'Follow project rules',
  tools: [
    {
      name: 'read_file',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
  messages: [{ role: 'user', content: '阅读 src/index.ts' }],
};

class CountingProvider implements LLMProvider {
  calls = 0;
  constructor(private readonly result: number | Error) {}
  async *complete(_messages: LLMMessage[], _opts: CompleteOptions): AsyncIterable<StreamEvent> {}
  async countTokens(): Promise<number> {
    this.calls++;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  modelInfo(): ModelInfo {
    return { contextWindowTokens: 1000, supportsToolUse: true };
  }
}

describe('RequestTokenCounter', () => {
  it('prefers and caches provider-native exact counts', async () => {
    const provider = new CountingProvider(123);
    const counter = new RequestTokenCounter(provider);
    await expect(counter.count(request)).resolves.toEqual({
      tokens: 123,
      accuracy: 'exact',
      source: 'provider',
    });
    await counter.count(request);
    expect(provider.calls).toBe(1);
  });

  it('falls back to the built-in tokenizer when exact counting fails', async () => {
    const provider = new CountingProvider(new Error('unsupported'));
    const counter = new RequestTokenCounter(provider);
    const result = await counter.count(request);
    expect(result.accuracy).toBe('tokenizer');
    expect(result.tokens).toBeGreaterThan(0);
    expect(provider.calls).toBe(1);

    await counter.count({ ...request, messages: [{ role: 'user', content: 'next' }] });
    expect(provider.calls).toBe(1);
  });

  it('uses the conservative estimator when the local tokenizer is unavailable', async () => {
    const provider = new CountingProvider(new Error('unsupported'));
    const counter = new RequestTokenCounter(provider, {
      localCount: () => {
        throw new Error('tokenizer unavailable');
      },
      estimate: () => 456,
    });
    await expect(counter.count(request)).resolves.toEqual({
      tokens: 456,
      accuracy: 'estimated',
      source: 'utf8-bytes',
    });
  });

  it('counts system, tool schema, protocol overhead, ASCII, and CJK', () => {
    const parts = countLocalRequestTokens(request);
    expect(parts.systemTokens).toBeGreaterThan(0);
    expect(parts.toolSchemaTokens).toBeGreaterThan(0);
    expect(parts.historyTokens).toBeGreaterThan(tokenizeText('阅读 src/index.ts'));
    expect(parts.totalTokens).toBe(
      parts.systemTokens + parts.toolSchemaTokens + parts.historyTokens,
    );
  });
});
