import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HybridSearchAdapter } from '../../src/tools/search/adapter.js';

let workdir: string;
const signal = new AbortController().signal;
const rgAvailable = (() => {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'kode-search-test-'));
  mkdirSync(join(workdir, 'src'));
  mkdirSync(join(workdir, 'src', 'generated'));
  mkdirSync(join(workdir, 'dist'));
  writeFileSync(join(workdir, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(workdir, 'src', 'a.ts'), 'const TODO = TODO;\nconst todo = 2;\n');
  writeFileSync(join(workdir, 'src', 'b.ts'), 'nothing\n');
  writeFileSync(join(workdir, 'src', '.gitignore'), 'generated/\n');
  writeFileSync(join(workdir, 'src', 'generated', 'skip.ts'), 'TODO\n');
  writeFileSync(join(workdir, 'ignored.txt'), 'TODO\n');
  writeFileSync(join(workdir, '.hidden.txt'), 'TODO\n');
  writeFileSync(join(workdir, 'dist', 'built.js'), 'TODO\n');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('search adapter', () => {
  it('Node glob is stable, hidden-aware, bounded, and respects ignores', async () => {
    const adapter = new HybridSearchAdapter('node');
    const result = await adapter.glob({
      root: workdir,
      pattern: '**/*',
      hidden: false,
      limit: 10,
      signal,
    });
    expect(result.files).toEqual(['src/a.ts', 'src/b.ts']);

    const hidden = await adapter.glob({
      root: workdir,
      pattern: '**/*',
      hidden: true,
      limit: 2,
      signal,
    });
    expect(hidden.truncated).toBe(true);
    expect(hidden.files).toHaveLength(2);
  });

  it('Node grep normalizes literal matches and skips ignored files', async () => {
    const result = await new HybridSearchAdapter('node').grep({
      root: workdir,
      pattern: 'todo',
      glob: '**/*.ts',
      literal: true,
      caseSensitive: false,
      context: 0,
      maxMatches: 10,
      signal,
    });
    expect(result.matches).toBe(2);
    expect(result.hits.every((hit) => hit.path === 'src/a.ts')).toBe(true);
    expect(result.hits.map((hit) => hit.line)).toEqual([1, 2]);
  });

  it.skipIf(!rgAvailable)('rg and Node return the same match locations', async () => {
    const query = {
      root: workdir,
      pattern: 'TODO',
      glob: '**/*.ts',
      literal: true,
      caseSensitive: true,
      context: 0,
      maxMatches: 10,
      signal,
    };
    const node = await new HybridSearchAdapter('node').grep(query);
    const rg = await new HybridSearchAdapter('rg').grep(query);
    expect(rg.hits).toEqual(node.hits);
    expect(rg.truncated).toBe(false);
  });

  it('rejects an already aborted search', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      new HybridSearchAdapter('node').glob({
        root: workdir,
        pattern: '**/*',
        hidden: false,
        limit: 10,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
