import { describe, expect, it } from 'vitest';
import { abortableSleep, isAbortError } from '../../src/llm/types.js';

describe('LLM abort helpers', () => {
  it('recognizes DOM and SDK abort errors', () => {
    class APIUserAbortError extends Error {}
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(new APIUserAbortError('Request was aborted'))).toBe(true);
    expect(isAbortError(new Error('network failure'))).toBe(false);
  });

  it('rejects immediately when sleep receives an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(abortableSleep(10_000, ac.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
