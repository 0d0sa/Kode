import type { Permissions } from '../config/schema.js';
import type { ToolSpec } from '../llm/types.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(private permissions: Permissions = {}) {}

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

  /**
   * Minimal permission gate (full policy table/audit in Phase 2):
   * overrides[tool] → read-only allow → permissions.default → 'confirm'.
   */
  private decisionFor(t: Tool): 'allow' | 'confirm' | 'deny' {
    const override = this.permissions.overrides?.[t.name];
    if (override) return override;
    if (t.isReadOnly) return 'allow';
    return this.permissions.default ?? 'confirm';
  }

  async dispatch(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const t = this.tools.get(name);
    if (!t) return { ok: false, output: `Unknown tool: ${name}` };

    const parsed = t.schema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      return { ok: false, output: `Invalid input for ${name}: ${detail}` };
    }
    if (ctx.signal.aborted) return abortedResult(name);

    const decision = this.decisionFor(t);
    if (decision === 'deny') {
      return { ok: false, output: `Tool ${name} is denied by config (permissions).` };
    }
    if (decision === 'confirm' && !ctx.isSessionApproved(name)) {
      const res = await ctx.approve({ tool: name, input: parsed.data });
      if (ctx.signal.aborted) return abortedResult(name);
      if (res.decision === 'deny') {
        return { ok: false, output: `User denied running ${name}.` };
      }
      if (res.scope === 'session') ctx.approveSession(name);
    }
    if (ctx.signal.aborted) return abortedResult(name);

    const log = ctx.logger.child({ component: 'tools' });
    const started = Date.now();
    try {
      const result = await t.execute(parsed.data, ctx);
      log.info({ tool: name, ok: result.ok, ms: Date.now() - started }, 'tool dispatch');
      return result;
    } catch (e) {
      log.warn({ tool: name, err: (e as Error).message }, 'tool error');
      return { ok: false, output: `${name} failed: ${(e as Error).message}` };
    }
  }
}

function abortedResult(name: string): ToolResult {
  return { ok: false, output: `Tool ${name} was aborted.` };
}
