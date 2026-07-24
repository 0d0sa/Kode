import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/tools/registry.js';
import {
  toInputSchema,
  type ApprovalRequest,
  type Tool,
  type ToolContext,
} from '../../src/tools/types.js';
import { testLogger } from './helpers.js';

const readSchema = z.object({ path: z.string() });
const readTool: Tool<z.infer<typeof readSchema>> = {
  name: 'read_thing',
  description: 'read-only',
  schema: readSchema,
  inputSchema: toInputSchema(readSchema),
  isReadOnly: true,
  async execute(input) {
    return { ok: true, output: `read:${input.path}` };
  },
};

const writeSchema = z.object({ path: z.string(), data: z.string() });
const writeTool: Tool<z.infer<typeof writeSchema>> = {
  name: 'write_thing',
  description: 'mutating',
  schema: writeSchema,
  inputSchema: toInputSchema(writeSchema),
  isReadOnly: false,
  async execute(input) {
    return { ok: true, output: `wrote:${input.path}` };
  },
};

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    approve: async () => ({ decision: 'deny' }),
    isSessionApproved: () => false,
    approveSession: () => {},
    logger: testLogger,
    ...overrides,
  };
}

describe('ToolRegistry.dispatch', () => {
  it('returns an error result for unknown tools', async () => {
    const r = new ToolRegistry();
    const res = await r.dispatch('nope', {}, ctx());
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/Unknown tool/);
  });

  it('validates input with zod and reports issues', async () => {
    const r = new ToolRegistry();
    r.register(readTool);
    const res = await r.dispatch('read_thing', { path: 42 }, ctx());
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/Invalid input for read_thing/);
  });

  it('auto-allows read-only tools without asking', async () => {
    const r = new ToolRegistry();
    r.register(readTool);
    let asked = false;
    const res = await r.dispatch(
      'read_thing',
      { path: 'a' },
      ctx({
        approve: async () => {
          asked = true;
          return { decision: 'deny' };
        },
      }),
    );
    expect(res).toMatchObject({ ok: true, output: 'read:a' });
    expect(asked).toBe(false);
  });

  it('confirms mutating tools by default; denial blocks execution', async () => {
    const r = new ToolRegistry();
    r.register(writeTool);
    const requests: ApprovalRequest[] = [];
    const res = await r.dispatch(
      'write_thing',
      { path: 'a', data: 'x' },
      ctx({
        approve: async (req) => {
          requests.push(req);
          return { decision: 'deny' };
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/denied/);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ tool: 'write_thing' });
  });

  it('runs after approval and skips the prompt when session-approved', async () => {
    const r = new ToolRegistry();
    r.register(writeTool);
    const approved = new Set<string>();
    let askCount = 0;
    const c = ctx({
      isSessionApproved: (n) => approved.has(n),
      approveSession: (n) => approved.add(n),
      approve: async () => {
        askCount++;
        return { decision: 'allow', scope: 'session' };
      },
    });
    const first = await r.dispatch('write_thing', { path: 'a', data: '1' }, c);
    const second = await r.dispatch('write_thing', { path: 'b', data: '2' }, c);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(askCount).toBe(1);
  });

  it('honours permissions overrides (deny beats read-only)', async () => {
    const r = new ToolRegistry({ overrides: { read_thing: 'deny' } });
    r.register(readTool);
    const res = await r.dispatch('read_thing', { path: 'a' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/denied by config/);
  });

  it('permissions.default=allow skips confirmation for mutating tools', async () => {
    const r = new ToolRegistry({ default: 'allow' });
    r.register(writeTool);
    const res = await r.dispatch('write_thing', { path: 'a', data: 'x' }, ctx());
    expect(res.ok).toBe(true);
  });

  it('does not execute a tool when abort fires during approval', async () => {
    const ac = new AbortController();
    let executed = false;
    const guardedTool: Tool<z.infer<typeof writeSchema>> = {
      ...writeTool,
      name: 'guarded_write',
      async execute() {
        executed = true;
        return { ok: true, output: 'unexpected' };
      },
    };
    const r = new ToolRegistry();
    r.register(guardedTool);
    const res = await r.dispatch(
      'guarded_write',
      { path: 'a', data: 'x' },
      ctx({
        signal: ac.signal,
        approve: async () => {
          ac.abort();
          return { decision: 'allow', scope: 'once' };
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, output: expect.stringMatching(/aborted/) });
    expect(executed).toBe(false);
  });

  it('specs() exposes name/description/input_schema for the LLM', () => {
    const r = new ToolRegistry();
    r.register(readTool);
    const specs = r.specs();
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ name: 'read_thing', description: 'read-only' });
    expect(specs[0]?.input_schema).toMatchObject({ type: 'object' });
    expect(specs[0]?.input_schema).not.toHaveProperty('$schema');
  });
});
