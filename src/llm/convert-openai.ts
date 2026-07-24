import type OpenAI from 'openai';
import type { ContentBlock, LLMMessage } from './types.js';

/**
 * Internal messages → OpenAI chat.completions params.
 * - `system` becomes a leading system message (OpenAI has no top-level system param).
 * - tool_result blocks become individual role:'tool' messages (one per result).
 * - assistant tool_use blocks become `tool_calls` with JSON-stringified arguments.
 */
export function toOpenAIMessages(
  messages: LLMMessage[],
  system?: string,
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : textOf(m.content);
      out.push({ role: 'system', content: text });
      continue;
    }
    if (m.role === 'tool') {
      if (typeof m.content === 'string') {
        throw new Error("role 'tool' requires ToolResultBlock[] content");
      }
      out.push(...m.content.map(toToolMessage));
      continue;
    }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
        continue;
      }
      // A user block list may carry tool_result blocks (loop output) and/or text.
      const textParts: string[] = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') out.push(toToolMessage(b));
        else if (b.type === 'text') textParts.push(b.text);
      }
      if (textParts.length) out.push({ role: 'user', content: textParts.join('') });
      continue;
    }
    // assistant
    if (typeof m.content === 'string') {
      out.push({ role: 'assistant', content: m.content });
      continue;
    }
    const textParts: string[] = [];
    const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
    for (const b of m.content) {
      if (b.type === 'text') textParts.push(b.text);
      else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      }
    }
    out.push({
      role: 'assistant',
      content: textParts.length ? textParts.join('') : null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  }
  return out;
}

function toToolMessage(b: ContentBlock): OpenAI.ChatCompletionToolMessageParam {
  if (b.type !== 'tool_result') {
    throw new Error(`role 'tool' only supports tool_result blocks, got ${b.type}`);
  }
  return { role: 'tool', tool_call_id: b.tool_use_id, content: b.content };
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function toOpenAITools(
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[],
): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}
