import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replaceInFileTool } from '../../src/tools/edit/replace.js';
import type { ToolContext } from '../../src/tools/types.js';
import { testLogger } from './helpers.js';

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'kode-replace-test-'));
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

describe('replace_in_file', () => {
  it('replaces a unique match and writes the file', async () => {
    writeFileSync(join(workdir, 'a.md'), '# Title\nold section\nend\n');
    const res = await replaceInFileTool.execute(
      { path: 'a.md', old_string: 'old section', new_string: '## Installation\npnpm install' },
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect(readFileSync(join(workdir, 'a.md'), 'utf8')).toBe(
      '# Title\n## Installation\npnpm install\nend\n',
    );
  });

  it('fails on zero matches without touching the file', async () => {
    writeFileSync(join(workdir, 'b.md'), 'content\n');
    const res = await replaceInFileTool.execute(
      { path: 'b.md', old_string: 'missing', new_string: 'x' },
      ctx(),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/not found/);
    expect(readFileSync(join(workdir, 'b.md'), 'utf8')).toBe('content\n');
  });

  it('fails on multiple matches unless replace_all is set', async () => {
    writeFileSync(join(workdir, 'c.md'), 'TODO one\nTODO two\n');
    const res = await replaceInFileTool.execute(
      { path: 'c.md', old_string: 'TODO', new_string: 'FIXME' },
      ctx(),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/matches 2 locations/);
    expect(readFileSync(join(workdir, 'c.md'), 'utf8')).toBe('TODO one\nTODO two\n');
  });

  it('replace_all rewrites every occurrence', async () => {
    writeFileSync(join(workdir, 'd.md'), 'TODO one\nTODO two\nTODO three\n');
    const res = await replaceInFileTool.execute(
      { path: 'd.md', old_string: 'TODO', new_string: 'FIXME', replace_all: true },
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect(res.meta).toMatchObject({ occurrences: 3 });
    expect(readFileSync(join(workdir, 'd.md'), 'utf8')).toBe('FIXME one\nFIXME two\nFIXME three\n');
  });

  it('reports missing files', async () => {
    const res = await replaceInFileTool.execute(
      { path: 'nope.md', old_string: 'a', new_string: 'b' },
      ctx(),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/File not found/);
  });

  it('rejects an empty old_string before execution', () => {
    expect(
      replaceInFileTool.schema.safeParse({
        path: 'a.md',
        old_string: '',
        new_string: 'x',
      }).success,
    ).toBe(false);
  });
});
