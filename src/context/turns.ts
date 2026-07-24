import type { ContentBlock, LLMMessage, ToolResultBlock, ToolUseBlock } from '../llm/types.js';
import type { ContextPriority } from './types.js';

export interface ContextGroup {
  start: number;
  end: number;
  kind: 'turn' | 'step_group';
}

export interface ContextEntry {
  index: number;
  message: LLMMessage;
  priority: ContextPriority;
  reason: string;
}

export function isPlainUserMessage(message: LLMMessage | undefined): boolean {
  return (
    message?.role === 'user' &&
    (typeof message.content === 'string' ||
      !message.content.some((block) => block.type === 'tool_result'))
  );
}

export function completeContextGroups(messages: readonly LLMMessage[]): ContextGroup[] {
  const groups: ContextGroup[] = [];
  let turnStart = 0;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (index > 0 && isPlainUserMessage(message)) {
      const previous = messages[index - 1];
      if (previous && !hasUnmatchedToolUse(previous)) {
        groups.push({ start: turnStart, end: index - 1, kind: 'turn' });
      }
      turnStart = index;
      continue;
    }

    if (isCompleteToolResultPair(messages[index - 1], message)) {
      groups.push({ start: index - 1, end: index, kind: 'step_group' });
    }
  }

  return uniqueByEnd(groups);
}

export function selectSummaryBoundary(
  messages: readonly LLMMessage[],
  preserveRecentGroups: number,
  afterMessage = -1,
): number | undefined {
  const candidates = completeContextGroups(messages)
    .map((group) => group.end)
    .filter((end) => end > afterMessage);
  const selected = candidates[candidates.length - preserveRecentGroups - 1];
  return selected;
}

export function classifyContextEntries(
  messages: readonly LLMMessage[],
  preserveRecentGroups: number,
  pins?: WeakMap<LLMMessage, ContextPriority>,
): ContextEntry[] {
  const entries: ContextEntry[] = messages.map((message, index) => ({
    index,
    message,
    priority: hasToolResult(message) ? 'compressible' : 'normal',
    reason: hasToolResult(message) ? 'older tool result' : 'ordinary history',
  }));
  const plainUsers = entries.filter((entry) => isPlainUserMessage(entry.message));
  const root = plainUsers[0];
  const latest = plainUsers.at(-1);
  if (root) mark(root, 'required', 'root user instruction');
  if (latest) mark(latest, 'required', 'latest user instruction');

  for (const entry of entries) {
    if (entry.message.role === 'system') mark(entry, 'required', 'system message');
    const pinned = pins?.get(entry.message);
    if (pinned) mark(entry, pinned, 'internal pin');
  }

  const groups = completeContextGroups(messages);
  const recent = groups.slice(-Math.max(1, preserveRecentGroups));
  for (const group of recent) {
    for (let index = group.start; index <= group.end; index++) {
      const entry = entries[index];
      if (entry) mark(entry, 'required', 'recent tool chain');
    }
  }
  const lastComplete = groups.at(-1)?.end ?? -1;
  for (let index = lastComplete + 1; index < entries.length; index++) {
    const entry = entries[index];
    if (entry) mark(entry, 'required', 'current incomplete chain');
  }
  return entries;
}

export function requiredMessageIndexes(
  messages: readonly LLMMessage[],
  preserveRecentGroups: number,
  pins?: WeakMap<LLMMessage, ContextPriority>,
): ReadonlySet<number> {
  return new Set(
    classifyContextEntries(messages, preserveRecentGroups, pins)
      .filter((entry) => entry.priority === 'required')
      .map((entry) => entry.index),
  );
}

export function protectedUserInstructions(
  messages: readonly LLMMessage[],
  throughMessage: number,
): string[] {
  const candidates: string[] = [];
  for (let index = 0; index <= throughMessage; index++) {
    const message = messages[index];
    if (!isPlainUserMessage(message)) continue;
    const text = messageText(message);
    if (text) candidates.push(text);
  }
  const first = candidates[0];
  const last = candidates.at(-1);
  if (!first) return [];
  if (!last || last === first) return [first];
  return [first, last];
}

export function cloneMessages(messages: readonly LLMMessage[]): LLMMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map((block) => cloneBlock(block)),
  }));
}

function isCompleteToolResultPair(
  assistant: LLMMessage | undefined,
  result: LLMMessage | undefined,
): boolean {
  if (assistant?.role !== 'assistant' || result?.role !== 'user') return false;
  if (typeof assistant.content === 'string' || typeof result.content === 'string') return false;
  const uses = assistant.content.filter(
    (block): block is ToolUseBlock => block.type === 'tool_use',
  );
  const results = result.content.filter(
    (block): block is ToolResultBlock => block.type === 'tool_result',
  );
  if (uses.length === 0 || uses.length !== results.length) return false;
  const resultIds = new Set(results.map((block) => block.tool_use_id));
  return uses.every((block) => resultIds.has(block.id));
}

function hasUnmatchedToolUse(message: LLMMessage): boolean {
  return (
    message.role === 'assistant' &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === 'tool_use')
  );
}

function hasToolResult(message: LLMMessage): boolean {
  return (
    Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result')
  );
}

function mark(entry: ContextEntry, priority: ContextPriority, reason: string): void {
  if (priorityRank(priority) <= priorityRank(entry.priority)) return;
  entry.priority = priority;
  entry.reason = reason;
}

function priorityRank(priority: ContextPriority): number {
  switch (priority) {
    case 'required':
      return 3;
    case 'high':
      return 2;
    case 'normal':
      return 1;
    case 'compressible':
      return 0;
  }
}

function messageText(message: LLMMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function uniqueByEnd(groups: ContextGroup[]): ContextGroup[] {
  const byEnd = new Map<number, ContextGroup>();
  for (const group of groups) {
    const current = byEnd.get(group.end);
    if (!current || group.kind === 'turn') byEnd.set(group.end, group);
  }
  return [...byEnd.values()].sort((a, b) => a.end - b.end);
}

function cloneBlock(block: ContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
      };
  }
}
