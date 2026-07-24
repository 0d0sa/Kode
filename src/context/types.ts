import type { LLMMessage, TokenCount, TokenCountRequest } from '../llm/types.js';

export type ContextPriority = 'required' | 'high' | 'normal' | 'compressible';

export interface TokenBudget {
  contextWindowTokens: number;
  maxOutputTokens: number;
  safetyReserveTokens: number;
  inputLimitTokens: number;
}

export interface ContextUsage {
  systemTokens: number;
  toolSchemaTokens: number;
  historyTokensBefore: number;
  historyTokensAfter: number;
  totalInputTokens: number;
  countAccuracy: TokenCount['accuracy'];
  countSource: string;
}

export type ContextActionKind =
  'compact_tool_result' | 'summarize_turns' | 'drop_turn' | 'reduce_output_reserve';

export interface ContextAction {
  kind: ContextActionKind;
  affectedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
  detail?: string;
}

export interface ContextCheckpoint {
  version: 1;
  throughMessage: number;
  summary: LLMMessage;
  sourceDigest: string;
  tokenCount: number;
  createdAt: string;
}

export interface ContextReport {
  budget: TokenBudget;
  usage: ContextUsage;
  actions: ContextAction[];
  checkpointReused: boolean;
  summaryCalls: number;
  durationMs: number;
}

export interface ContextResolution {
  messages: LLMMessage[];
  maxOutputTokens: number;
  report: ContextReport;
  checkpoint?: ContextCheckpoint;
}

export interface ContextResolveRequest extends TokenCountRequest {
  requestedOutputTokens: number;
  signal?: AbortSignal;
}

export interface ResolvedContextOptions {
  enabled: boolean;
  windowTokens?: number;
  safetyReserveTokens: number;
  minimumOutputTokens: number;
  preserveRecentTurns: number;
  toolResultTokens: number;
  summaryTriggerRatio: number;
}

export interface ToolResultContextRecord {
  name: string;
  input: unknown;
  ok: boolean;
  meta?: Record<string, unknown>;
}
