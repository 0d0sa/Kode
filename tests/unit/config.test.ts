import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findConfigFiles, homeConfigPath } from '../../src/config/find.js';
import { loadConfig } from '../../src/config/loader.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'kode-test-'));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('findConfigFiles', () => {
  it('walks up and returns closest-first', () => {
    const root = join(workdir, 'proj');
    mkdirSync(join(root, 'packages', 'a'), { recursive: true });
    const rootFile = join(root, 'kode.jsonc');
    writeFileSync(rootFile, '{}');
    const found = findConfigFiles(join(root, 'packages', 'a'));
    expect(found[0]).toBe(rootFile);
  });

  it('appends home config last when present on this machine', () => {
    mkdirSync(workdir, { recursive: true });
    const projectFile = join(workdir, 'kode.jsonc');
    writeFileSync(projectFile, '{}');
    const found = findConfigFiles(workdir);
    expect(found[0]).toBe(projectFile);
    const home = homeConfigPath();
    const homeIdx = found.indexOf(home);
    if (homeIdx !== -1) {
      expect(homeIdx).toBe(found.length - 1);
    }
  });
});

describe('loadConfig', () => {
  it('returns default config when no files are given', () => {
    const { config, files } = loadConfig([]);
    expect(files).toEqual([]);
    expect(config.version).toBe(1);
  });

  it('parses jsonc with comments and trailing comma', () => {
    const f = join(workdir, 'kode.jsonc');
    writeFileSync(f, '{\n  // project\n  "version": 1,\n}');
    const { config } = loadConfig([f]);
    expect(config.version).toBe(1);
  });

  it('rejects invalid schema with a friendly message', () => {
    const f = join(workdir, 'kode.jsonc');
    writeFileSync(f, '{ "model": { "provider": "weird" } }');
    expect(() => loadConfig([f])).toThrow(/provider/i);
  });

  it('rejects malformed jsonc with parse error', () => {
    const f = join(workdir, 'kode.jsonc');
    writeFileSync(f, '{ "version": @ }');
    expect(() => loadConfig([f])).toThrow(/parse error/i);
  });

  it('closest file overrides farthest on a per-key (shallow) basis', () => {
    const far = join(workdir, 'far.jsonc');
    const near = join(workdir, 'near.jsonc');
    writeFileSync(far, JSON.stringify({ version: 1, rules: ['a', 'b'] }));
    writeFileSync(near, JSON.stringify({ version: 1, rules: ['c'] }));
    // Pass closest-first, as `findConfigFiles` would.
    const { config } = loadConfig([near, far]);
    expect(config.rules).toEqual(['c']);
  });
});