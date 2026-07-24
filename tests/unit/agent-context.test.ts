import { describe, expect, it } from 'vitest';
import { trimMessages } from '../../src/agent/context.js';
import type { LLMMessage } from '../../src/llm/types.js';

const user = (s: string): LLMMessage => ({ role: 'user', content: s });
const assistantText = (s: string): LLMMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: s }],
});
const assistantToolUse = (id: string): LLMMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'read_file', input: {} }],
});
const toolResult = (id: string): LLMMessage => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
});

describe('trimMessages', () => {
  it('returns messages unchanged when within the limit', () => {
    const msgs = [user('a'), assistantText('b')];
    expect(trimMessages(msgs, 20)).toBe(msgs);
  });

  it('keeps the most recent N messages', () => {
    const msgs = [user('1'), assistantText('2'), user('3'), assistantText('4')];
    expect(trimMessages(msgs, 2)).toEqual([user('3'), assistantText('4')]);
  });

  it('extends backwards when the window starts at a tool_result message', () => {
    const msgs = [
      user('start'),
      assistantToolUse('t1'),
      toolResult('t1'),
      assistantText('done'),
      user('next'),
    ];
    // keep=3 would start at toolResult('t1'); alignment pulls in the whole user turn.
    const out = trimMessages(msgs, 3);
    expect(out).toEqual([
      user('start'),
      assistantToolUse('t1'),
      toolResult('t1'),
      assistantText('done'),
      user('next'),
    ]);
  });

  it('never splits a tool_use/tool_result pair', () => {
    const msgs = [
      user('a'),
      assistantToolUse('t1'),
      toolResult('t1'),
      assistantToolUse('t2'),
      toolResult('t2'),
    ];
    const out = trimMessages(msgs, 2);
    // A continuous tool chain cannot be split without orphaning an earlier result.
    expect(out[0]).toEqual(user('a'));
    expect(out).toHaveLength(5);
  });

  it('does not start a provider request with an assistant message', () => {
    const msgs = [user('1'), assistantText('2'), user('3'), assistantText('4')];
    expect(trimMessages(msgs, 1)).toEqual([user('3'), assistantText('4')]);
  });

  it('handles keep larger than history and degenerate keep values', () => {
    const msgs = [user('a')];
    expect(trimMessages(msgs, 100)).toBe(msgs);
    expect(trimMessages(msgs, 0)).toBe(msgs);
  });
});
