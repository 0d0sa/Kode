import { describe, expect, it } from 'vitest';
import { toAnthropicMessages } from '../../src/llm/convert-anthropic.js';
import type { LLMMessage } from '../../src/llm/types.js';

describe('toAnthropicMessages', () => {
  it('extracts system messages into the top-level system param', () => {
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'You are Kode.' },
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(system).toBe('You are Kode.\n\nBe concise.');
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('omits system when no system messages exist', () => {
    const r = toAnthropicMessages([{ role: 'user', content: 'hi' }]);
    expect(r.system).toBeUndefined();
  });

  it('maps text/tool_use/tool_result blocks', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me read' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x', is_error: true }],
      },
    ];
    const { messages } = toAnthropicMessages(msgs);
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me read' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    });
    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x', is_error: true }],
    });
  });

  it('maps role tool with block content to a user message', () => {
    const { messages } = toAnthropicMessages([
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]);
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]);
  });

  it('throws on role tool with string content', () => {
    expect(() => toAnthropicMessages([{ role: 'tool', content: 'nope' }])).toThrow(/tool/);
  });
});
