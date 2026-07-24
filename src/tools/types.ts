import type { Logger } from 'pino';
import type { ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface Tool<I = unknown> {
  name: string;
  description: string;
  /** Runtime input validation (single source of truth). */
  schema: ZodType<I>;
  /** JSON Schema injected into the LLM, derived from `schema`. */
  inputSchema: Record<string, unknown>;
  isReadOnly: boolean;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  approve(req: ApprovalRequest): Promise<ApprovalResult>;
  isSessionApproved(toolName: string): boolean;
  approveSession(toolName: string): void;
  logger: Logger;
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
