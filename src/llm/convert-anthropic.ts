import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, LLMMessage } from './types.js';

/**
 * Internal messages → Anthropic params.
 * - `system` messages are extracted to the top-level `system` param.
 * - role 'tool' is only supported as ToolResultBlock[] (mapped to a user message);
 *   the agent loop never produces it (it appends user messages with tool_result blocks).
 * - Anthropic requires strict user/assistant alternation and tool_use/tool_result
 *   pairing; the loop's append order guarantees both, so no reordering happens here.
 */
export function toAnthropicMessages(messages: LLMMessage[]): {
  system?: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(typeof m.content === 'string' ? m.content : textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      if (typeof m.content === 'string') {
        throw new Error("role 'tool' requires ToolResultBlock[] content");
      }
      out.push({ role: 'user', content: m.content.map(toAnthropicBlock) });
      continue;
    }
    out.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(toAnthropicBlock),
    });
  }
  return {
    ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
    messages: out,
  };
}

function toAnthropicBlock(b: ContentBlock): Anthropic.ContentBlockParam {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: b.content,
        ...(b.is_error !== undefined ? { is_error: b.is_error } : {}),
      };
  }
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
