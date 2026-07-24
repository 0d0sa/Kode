import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findConfigFiles } from '../../src/config/find.js';
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

  it('appends the global config after project configs', () => {
    const projectDir = join(workdir, 'project', 'packages', 'a');
    const projectFile = join(workdir, 'project', 'kode.jsonc');
    const globalFile = join(workdir, 'home', '.kode', 'kode.jsonc');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(workdir, 'home', '.kode'), { recursive: true });
    writeFileSync(projectFile, '{}');
    writeFileSync(globalFile, '{}');

    expect(findConfigFiles(projectDir, globalFile)).toEqual([projectFile, globalFile]);
  });

  it('does not return the global config twice when cwd is its directory', () => {
    const globalDir = join(workdir, '.kode');
    const globalFile = join(globalDir, 'kode.jsonc');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(globalFile, '{}');

    expect(findConfigFiles(globalDir, globalFile)).toEqual([globalFile]);
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

  it('requires baseURL for a local provider', () => {
    const f = join(workdir, 'kode.jsonc');
    writeFileSync(f, JSON.stringify({ model: { provider: 'local', model: 'local-model' } }));
    expect(() => loadConfig([f])).toThrow(/baseURL/);
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

  it('parses ordered Phase 2 permission rules', () => {
    const f = join(workdir, 'kode.jsonc');
    writeFileSync(
      f,
      JSON.stringify({
        permissions: {
          rules: [
            {
              id: 'allow-tests',
              decision: 'allow',
              tools: ['run_command'],
              commandPrefixes: ['pnpm test'],
            },
          ],
        },
      }),
    );
    const { config } = loadConfig([f]);
    expect(config.permissions?.rules?.[0]).toMatchObject({
      id: 'allow-tests',
      decision: 'allow',
    });
  });

  it('rejects permission rules without a matcher', () => {
    const f = join(workdir, 'kode.jsonc');
    writeFileSync(
      f,
      JSON.stringify({ permissions: { rules: [{ id: 'bad', decision: 'allow' }] } }),
    );
    expect(() => loadConfig([f])).toThrow(/matcher/);
  });

  it('parses Phase 3 context settings without changing contextMessages compatibility', () => {
    const f = join(workdir, 'kode.jsonc');
    writeFileSync(
      f,
      JSON.stringify({
        agent: {
          contextMessages: 20,
          context: {
            windowTokens: 128000,
            safetyReserveTokens: 2048,
            minimumOutputTokens: 1024,
            preserveRecentTurns: 3,
            toolResultTokens: 2048,
            summaryTriggerRatio: 0.8,
          },
        },
      }),
    );
    const { config } = loadConfig([f]);
    expect(config.agent?.contextMessages).toBe(20);
    expect(config.agent?.context?.windowTokens).toBe(128000);
  });

  it('parses Phase 4 codebase settings and keeps semantic search disabled', () => {
    const f = join(workdir, 'kode.jsonc');
    writeFileSync(
      f,
      JSON.stringify({
        codebase: {
          enabled: true,
          languages: ['typescript', 'python', 'go', 'rust'],
          cache: 'global',
          refresh: 'incremental',
          maxFiles: 50000,
          maxFileBytes: 2097152,
          parseConcurrency: 4,
          overviewTokens: 1800,
          semanticSearch: { enabled: false },
        },
      }),
    );
    const { config } = loadConfig([f]);
    expect(config.codebase?.languages).toContain('rust');
    expect(config.codebase?.semanticSearch?.enabled).toBe(false);

    writeFileSync(f, JSON.stringify({ codebase: { semanticSearch: { enabled: true } } }));
    expect(() => loadConfig([f])).toThrow(/semanticSearch/);
  });

  it('rejects a minimum output reserve larger than the configured context window', () => {
    const f = join(workdir, 'kode.jsonc');
    writeFileSync(
      f,
      JSON.stringify({
        agent: { context: { windowTokens: 1000, minimumOutputTokens: 1000 } },
      }),
    );
    expect(() => loadConfig([f])).toThrow(/minimumOutputTokens/);
  });

  it('rejects incompatible safety, window, and requested output limits', () => {
    const f = join(workdir, 'kode.jsonc');
    writeFileSync(
      f,
      JSON.stringify({
        model: { provider: 'openai', model: 'mock', maxTokens: 100 },
        agent: {
          context: {
            windowTokens: 1000,
            safetyReserveTokens: 900,
            minimumOutputTokens: 100,
          },
        },
      }),
    );
    expect(() => loadConfig([f])).toThrow(/safetyReserveTokens/);

    writeFileSync(
      f,
      JSON.stringify({
        model: { provider: 'openai', model: 'mock', maxTokens: 100 },
        agent: { context: { minimumOutputTokens: 200 } },
      }),
    );
    expect(() => loadConfig([f])).toThrow(/model\.maxTokens/);
  });
});
