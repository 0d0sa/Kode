import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommandTool } from '../../src/tools/shell/run.js';
import type { ToolContext } from '../../src/tools/types.js';
import { testLogger } from './helpers.js';

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'kode-run-test-'));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function ctx(signal: AbortSignal = new AbortController().signal): ToolContext {
  return {
    cwd: workdir,
    signal,
    approve: async () => ({ decision: 'allow' }),
    isSessionApproved: () => false,
    approveSession: () => {},
    logger: testLogger,
  };
}

describe('run_command', () => {
  it('captures stdout and exit code 0', async () => {
    const res = await runCommandTool.execute({ command: 'echo hello' }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain('exit code: 0');
    expect(res.output).toContain('hello');
  });

  it('reports non-zero exit codes and stderr', async () => {
    const res = await runCommandTool.execute({ command: 'echo oops >&2; exit 3' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.output).toContain('exit code: 3');
    expect(res.output).toContain('[stderr]');
    expect(res.output).toContain('oops');
  });

  it('runs in the working directory', async () => {
    const res = await runCommandTool.execute({ command: 'pwd' }, ctx());
    // macOS tmpdir may be a symlink (/var → /private/var); compare realpaths.
    const out = res.output;
    expect(res.ok).toBe(true);
    expect(out.replace('/private', '')).toContain(workdir.replace('/private', ''));
  });

  it('kills the process on timeout', async () => {
    const started = Date.now();
    // execute() trusts its input (schema validation happens in dispatch), so a
    // sub-1000ms timeout is fine here and keeps the test fast.
    const res = await runCommandTool.execute({ command: 'sleep 30', timeout_ms: 300 }, ctx());
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('[killed');
  });

  it('kills the process when the abort signal fires', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = runCommandTool.execute({ command: 'sleep 30 & wait' }, ctx(ac.signal));
    setTimeout(() => ac.abort(), 100);
    const res = await p;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('[killed');
  });

  it('does not spawn when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const res = await runCommandTool.execute({ command: 'sleep 30' }, ctx(ac.signal));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res).toMatchObject({ ok: false, output: expect.stringMatching(/aborted/) });
  });

  it('bounds noisy output while preserving its tail', async () => {
    const res = await runCommandTool.execute(
      {
        command:
          "node -e \"process.stdout.write('x'.repeat(2_000_000)); process.stdout.write('TAIL_MARKER')\"",
      },
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain('[truncated: showing output tail]');
    expect(res.output).toContain('TAIL_MARKER');
    expect(Buffer.byteLength(res.output)).toBeLessThan(60 * 1024);
  });
});
