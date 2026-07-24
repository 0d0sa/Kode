import type { Logger } from 'pino';
import type { ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolPermission } from '../permission/types.js';
import type { UndoStore } from './undo/types.js';

export interface Tool<I = unknown> {
  name: string;
  description: string;
  /** Runtime input validation (single source of truth). */
  schema: ZodType<I>;
  /** JSON Schema injected into the LLM, derived from `schema`. */
  inputSchema: Record<string, unknown>;
  isReadOnly: boolean;
  /** Optional fine-grained permission targets. Registry falls back to tool-level risk. */
  permission?(input: I, ctx: ToolContext): Promise<ToolPermission> | ToolPermission;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  approve(req: ApprovalRequest): Promise<ApprovalResult>;
  isSessionApproved(scopeKey: string): boolean;
  approveSession(scopeKey: string): void;
  logger: Logger;
  runId?: string;
  toolCallId?: string;
  undoStore?: UndoStore;
  /** Canonical paths approved by the registry for this dispatch. */
  authorizedPaths?: ReadonlySet<string>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  meta?: Record<string, unknown>;
}

export interface ApprovalRequest {
  tool: string;
  input: unknown;
  reason?: string;
  summary?: string;
  scopeKeys?: string[];
}

export interface ApprovalResult {
  decision: 'allow' | 'deny';
  scope?: 'once' | 'session';
}

/** zod → JSON Schema, stripping the $schema key for LLM tool input_schema. */
export function toInputSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _dropped, ...rest } = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
  }) as Record<string, unknown>;
  return rest;
}
