import type { ContentBlock, LLMMessage, ToolResultBlock, ToolUseBlock } from '../llm/types.js';
import { tokenizeText } from './counter.js';
import type { ToolResultContextRecord } from './types.js';
import { cloneMessages } from './turns.js';

export interface ToolCompactionResult {
  messages: LLMMessage[];
  affectedMessages: number;
}

export function compactToolResults(
  messages: readonly LLMMessage[],
  records: ReadonlyMap<string, ToolResultContextRecord>,
  maxTokens: number,
  protectedMessageIndexes: ReadonlySet<number> = new Set(),
): ToolCompactionResult {
  const cloned = cloneMessages(messages);
  const uses = collectToolUses(messages);
  let affectedMessages = 0;

  for (const [messageIndex, message] of cloned.entries()) {
    if (protectedMessageIndexes.has(messageIndex)) continue;
    if (!Array.isArray(message.content)) continue;
    let changed = false;
    message.content = message.content.map((block) => {
      if (block.type !== 'tool_result' || tokenizeText(block.content) <= maxTokens) return block;
      const compacted = compactBlock(
        block,
        uses.get(block.tool_use_id),
        records.get(block.tool_use_id),
        maxTokens,
      );
      if (tokenizeText(compacted.content) >= tokenizeText(block.content)) return block;
      changed = true;
      return compacted;
    });
    if (changed) affectedMessages++;
  }

  return { messages: cloned, affectedMessages };
}

function collectToolUses(
  messages: readonly LLMMessage[],
): Map<string, { name: string; input: unknown }> {
  const uses = new Map<string, { name: string; input: unknown }>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') uses.set(block.id, { name: block.name, input: block.input });
    }
  }
  return uses;
}

function compactBlock(
  block: ToolResultBlock,
  use: Pick<ToolUseBlock, 'name' | 'input'> | undefined,
  record: ToolResultContextRecord | undefined,
  maxTokens: number,
): ToolResultBlock {
  const name = record?.name ?? use?.name ?? 'unknown';
  const status = record ? (record.ok ? 'ok' : 'error') : block.is_error ? 'error' : 'ok';
  const header = [
    '[context-compacted]',
    `tool: ${name}`,
    `tool_call_id: ${block.tool_use_id}`,
    `status: ${status}`,
    `original_chars: ${block.content.length}`,
    `input: ${boundedJson(record?.input ?? use?.input, 600)}`,
    ...(record?.meta ? [`meta: ${boundedJson(record.meta, 1200)}`] : []),
  ].join('\n');
  const characterBudget = Math.max(256, maxTokens * 3 - header.length);
  const body = preserveHeadAndTail(block.content, characterBudget);
  return {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content: `${header}\ncontent_excerpt:\n${body}`,
    ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
  };
}

function preserveHeadAndTail(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = '\n...[context middle omitted]...\n';
  const remaining = Math.max(0, limit - marker.length);
  const head = Math.ceil(remaining * 0.6);
  const tail = remaining - head;
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

function boundedJson(value: unknown, limit: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? {});
  } catch {
    serialized = '"[unserializable]"';
  }
  return preserveHeadAndTail(serialized, limit);
}
