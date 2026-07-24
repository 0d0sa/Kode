import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileTool } from '../../src/tools/fs/read.js';
import type { ToolContext } from '../../src/tools/types.js';
import { testLogger } from './helpers.js';

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'kode-read-test-'));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    cwd: workdir,
    signal: new AbortController().signal,
    approve: async () => ({ decision: 'allow' }),
    isSessionApproved: () => false,
    approveSession: () => {},
    logger: testLogger,
  };
}

describe('read_file', () => {
  it('reads a file with 1-based line numbers', async () => {
    writeFileSync(join(workdir, 'a.txt'), 'alpha\nbeta\ngamma');
    const res = await readFileTool.execute({ path: 'a.txt' }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toBe('1: alpha\n2: beta\n3: gamma');
  });

  it('pages with offset and limit', async () => {
    writeFileSync(join(workdir, 'b.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    const res = await readFileTool.execute({ path: 'b.txt', offset: 2, limit: 2 }, ctx());
    expect(res.output).toContain('2: l2\n3: l3');
    expect(res.output).toContain('[truncated: showing lines 2-3 of 6]');
  });

  it('resolves absolute paths', async () => {
    const p = join(workdir, 'c.txt');
    writeFileSync(p, 'x');
    const res = await readFileTool.execute({ path: p }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toBe('1: x');
  });

  it('reports missing files', async () => {
    const res = await readFileTool.execute({ path: 'nope.txt' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/File not found/);
  });

  it('rejects directories', async () => {
    mkdirSync(join(workdir, 'dir'));
    const res = await readFileTool.execute({ path: 'dir' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/directory/);
  });
});
