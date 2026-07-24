import type { Permissions } from '../config/schema.js';
import type { ToolSpec } from '../llm/types.js';
import { evaluatePolicy } from '../permission/policy.js';
import { summarizePermissionInput } from '../permission/summarize.js';
import type { AuditEvent, AuditSink, PolicyResult, ToolPermission } from '../permission/types.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

export interface ToolRegistryOptions {
  audit?: AuditSink;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(
    private permissions: Permissions = {},
    private options: ToolRegistryOptions = {},
  ) {}

  register(t: Tool): void {
    this.tools.set(t.name, t);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  async dispatch(
    name: string,
    input: unknown,
    ctx: ToolContext,
    toolCallId?: string,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, output: `Unknown tool: ${name}` };

    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      return { ok: false, output: `Invalid input for ${name}: ${detail}` };
    }
    if (ctx.signal.aborted) {
      await this.audit(ctx, {
        tool: name,
        decision: 'deny',
        source: 'builtin',
        scope: 'once',
        inputSummary: summarizePermissionInput(parsed.data),
        outcome: 'aborted',
      });
      return abortedResult(name);
    }

    let policy: PolicyResult;
    let permission: ToolPermission;
    try {
      permission = tool.permission
        ? await tool.permission(parsed.data, ctx)
        : { kind: tool.isReadOnly ? ('read' as const) : ('write' as const) };
      policy = evaluatePolicy({ tool: name, permission }, this.permissions, (scopeKey) =>
        ctx.isSessionApproved(scopeKey),
      );
    } catch (error) {
      return { ok: false, output: `${name} permission check failed: ${(error as Error).message}` };
    }

    const inputSummary = summarizePermissionInput(parsed.data);
    if (policy.decision === 'deny') {
      await this.audit(ctx, {
        tool: name,
        decision: 'deny',
        source: policy.source,
        scope: 'config',
        inputSummary,
        outcome: 'error',
      });
      return {
        ok: false,
        output: `Tool ${name} is denied${policy.source === 'config' ? ' by config' : ''}: ${policy.reason}.`,
      };
    }

    let finalSource = policy.source;
    let finalScope: AuditEvent['scope'] = 'config';
    if (policy.decision === 'confirm') {
      await this.audit(ctx, {
        tool: name,
        decision: 'confirm',
        source: policy.source,
        scope: 'config',
        inputSummary,
      });
      const approval = await ctx.approve({
        tool: name,
        input: parsed.data,
        reason: policy.reason,
        summary: inputSummary,
        scopeKeys: policy.scopeKeys,
      });
      if (ctx.signal.aborted) {
        await this.audit(ctx, {
          tool: name,
          decision: 'deny',
          source: 'user',
          scope: 'once',
          inputSummary,
          outcome: 'aborted',
        });
        return abortedResult(name);
      }
      if (approval.decision === 'deny') {
        await this.audit(ctx, {
          tool: name,
          decision: 'deny',
          source: 'user',
          scope: 'once',
          inputSummary,
          outcome: 'error',
        });
        return { ok: false, output: `User denied running ${name}.` };
      }
      finalSource = 'user';
      finalScope = approval.scope ?? 'once';
      if (approval.scope === 'session') {
        for (const scopeKey of policy.scopeKeys) ctx.approveSession(scopeKey);
      }
    } else if (policy.source === 'session') {
      finalScope = 'session';
    }

    if (ctx.signal.aborted) {
      await this.audit(ctx, {
        tool: name,
        decision: 'deny',
        source: 'builtin',
        scope: 'once',
        inputSummary,
        outcome: 'aborted',
      });
      return abortedResult(name);
    }
    const log = ctx.logger.child({ component: 'tools' });
    const started = Date.now();
    let result: ToolResult;
    try {
      const authorizedPaths = permission.paths?.map((path) => path.canonical);
      const dispatchContext = toolCallId ? { ...ctx, toolCallId } : ctx;
      const executionContext = authorizedPaths
        ? { ...dispatchContext, authorizedPaths: new Set(authorizedPaths) }
        : dispatchContext;
      result = await tool.execute(parsed.data, executionContext);
      log.info({ tool: name, ok: result.ok, ms: Date.now() - started }, 'tool dispatch');
    } catch (error) {
      log.warn({ tool: name, err: (error as Error).message }, 'tool error');
      result = { ok: false, output: `${name} failed: ${(error as Error).message}` };
    }
    await this.audit(ctx, {
      tool: name,
      decision: 'allow',
      source: finalSource,
      scope: finalScope,
      inputSummary,
      outcome: ctx.signal.aborted ? 'aborted' : result.ok ? 'ok' : 'error',
      durationMs: Date.now() - started,
    });
    return result;
  }

  private async audit(
    ctx: ToolContext,
    event: Omit<AuditEvent, 'timestamp' | 'runId' | 'cwd'>,
  ): Promise<void> {
    if (!this.options.audit) return;
    try {
      await this.options.audit.write({
        timestamp: new Date().toISOString(),
        runId: ctx.runId ?? 'unknown',
        cwd: ctx.cwd,
        ...event,
      });
    } catch (error) {
      ctx.logger.warn({ err: (error as Error).message }, 'permission audit write failed');
    }
  }
}

function abortedResult(name: string): ToolResult {
  return { ok: false, output: `Tool ${name} was aborted.` };
}
