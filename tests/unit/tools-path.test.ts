import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveToolPath } from '../../src/tools/path.js';

let workdir: string;
let outside: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'kode-path-work-'));
  outside = mkdtempSync(join(tmpdir(), 'kode-path-outside-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('resolveToolPath', () => {
  it('canonicalizes workspace paths and missing descendants', async () => {
    mkdirSync(join(workdir, 'src'));
    writeFileSync(join(workdir, 'src', 'a.ts'), 'x');
    const existing = await resolveToolPath(workdir, 'src/a.ts');
    const missing = await resolveToolPath(workdir, 'src/new.ts', { allowMissing: true });
    expect(existing).toMatchObject({ relative: 'src/a.ts', exists: true, outsideWorkspace: false });
    expect(missing).toMatchObject({
      relative: 'src/new.ts',
      exists: false,
      outsideWorkspace: false,
    });
  });

  it('classifies absolute paths and symlink descendants outside the workspace', async () => {
    symlinkSync(outside, join(workdir, 'linked'));
    const absolute = await resolveToolPath(workdir, join(outside, 'new.txt'), {
      allowMissing: true,
    });
    const linked = await resolveToolPath(workdir, 'linked/new.txt', { allowMissing: true });
    expect(absolute.outsideWorkspace).toBe(true);
    expect(linked.outsideWorkspace).toBe(true);
    expect(linked.canonical).toBe(join(realpathSync(outside), 'new.txt'));
  });
});
