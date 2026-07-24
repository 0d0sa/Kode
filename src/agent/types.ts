import type { LLMMessage, LLMProvider } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext, ToolResult } from '../tools/types.js';

export const DEFAULT_MAX_STEPS = 25;
export const DEFAULT_CONTEXT_MESSAGES = 20;

export type AgentDoneReason = 'end_turn' | 'max_tokens' | 'max_steps' | 'aborted';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: ToolResult }
  | { type: 'step'; index: number }
  | { type: 'done'; reason: AgentDoneReason };

export interface AgentRunOptions {
  provider: LLMProvider;
  registry: ToolRegistry;
  model: string;
  system: string;
  /** Live history: the loop pushes into this array so the caller keeps it across turns. */
  messages: LLMMessage[];
  maxSteps: number;
  contextMessages: number;
  ctx: ToolContext;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}
