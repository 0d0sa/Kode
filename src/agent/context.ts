import type { LLMMessage } from '../llm/types.js';

/**
 * Sliding-window context budget (Phase 1): keep the most recent `keep` messages.
 * Provider alignment: extend backwards to a real user turn when the cut would
 * start with an assistant/tool message or an orphaned tool_result. This may keep
 * more than `keep` messages for one uninterrupted tool chain. Phase 3 replaces
 * this with a token-budget resolver; call sites stay the same.
 */
export function trimMessages(messages: LLMMessage[], keep: number): LLMMessage[] {
  if (keep < 1 || messages.length <= keep) return messages;
  let start = messages.length - keep;
  while (start > 0 && (messages[start]?.role !== 'user' || hasToolResult(messages[start]))) {
    start--;
  }
  return messages.slice(start);
}

function hasToolResult(m: LLMMessage | undefined): boolean {
  return (
    m !== undefined && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
  );
}
