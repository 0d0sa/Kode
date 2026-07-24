import { describe, expect, it } from 'vitest';
import {
  classifyContextEntries,
  completeContextGroups,
  selectSummaryBoundary,
} from '../../src/context/turns.js';
import type { LLMMessage } from '../../src/llm/types.js';

const messages: LLMMessage[] = [
  { role: 'user', content: 'root task' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'old result' }],
  },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't2', name: 'grep', input: {} }],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't2', content: 'latest result' }],
  },
];

describe('context turn grouping and priority', () => {
  it('uses complete assistant/tool-result pairs as indivisible boundaries', () => {
    expect(completeContextGroups(messages).map((group) => group.end)).toEqual([2, 4]);
    expect(selectSummaryBoundary(messages, 1)).toBe(2);
  });

  it('marks root, latest user input, and recent tool chains as required', () => {
    const entries = classifyContextEntries(messages, 1);
    expect(entries[0]).toMatchObject({ priority: 'required', reason: 'root user instruction' });
    expect(entries[1]).toMatchObject({ priority: 'normal' });
    expect(entries[2]).toMatchObject({ priority: 'compressible' });
    expect(entries[3]).toMatchObject({ priority: 'required', reason: 'recent tool chain' });
    expect(entries[4]).toMatchObject({ priority: 'required' });
  });

  it('honors an internal pin without adding metadata to the message', () => {
    const pins = new WeakMap<LLMMessage, 'required'>();
    const pinned = messages[1] as LLMMessage;
    pins.set(pinned, 'required');
    const entries = classifyContextEntries(messages, 1, pins);
    expect(entries[1]).toMatchObject({ priority: 'required', reason: 'internal pin' });
    expect(pinned).not.toHaveProperty('priority');
  });
});
