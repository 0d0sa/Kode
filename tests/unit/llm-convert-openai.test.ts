import { describe, expect, it } from 'vitest';
import { toOpenAIMessages, toOpenAITools } from '../../src/llm/convert-openai.js';
import type { LLMMessage } from '../../src/llm/types.js';

describe('toOpenAIMessages', () => {
  it('prepends the system option as a leading system message', () => {
    const out = toOpenAIMessages([{ role: 'user', content: 'hi' }], 'You are Kode.');
    expect(out[0]).toEqual({ role: 'system', content: 'You are Kode.' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('converts internal system messages too', () => {
    const out = toOpenAIMessages([{ role: 'system', content: 'sys' }]);
    expect(out).toEqual([{ role: 'system', content: 'sys' }]);
  });

  it('splits user tool_result blocks into role tool messages', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'out1' },
          { type: 'tool_result', tool_use_id: 'c2', content: 'out2' },
        ],
      },
    ];
    const out = toOpenAIMessages(msgs);
    expect(out).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'out1' },
      { role: 'tool', tool_call_id: 'c2', content: 'out2' },
    ]);
  });

  it('maps assistant tool_use blocks to tool_calls with JSON arguments', () => {
    const msgs: LLMMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
    ];
    const out = toOpenAIMessages(msgs);
    expect(out[0]).toEqual({
      role: 'assistant',
      content: 'reading',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
        },
      ],
    });
  });

  it('uses null content for assistant messages with only tool calls', () => {
    const out = toOpenAIMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'run_command', input: { command: 'ls' } }],
      },
    ]);
    expect(out[0]).toMatchObject({ role: 'assistant', content: null });
  });

  it('throws on role tool with string content', () => {
    expect(() => toOpenAIMessages([{ role: 'tool', content: 'nope' }])).toThrow(/tool/);
  });
});

describe('toOpenAITools', () => {
  it('wraps specs as function tools', () => {
    const tools = toOpenAITools([
      { name: 'read_file', description: 'read', input_schema: { type: 'object' } },
    ]);
    expect(tools).toEqual([
      {
        type: 'function',
        function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
      },
    ]);
  });
});
