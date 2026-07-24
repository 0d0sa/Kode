import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditSink } from '../../src/permission/audit.js';
import { summarizePermissionInput } from '../../src/permission/summarize.js';

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('permission audit', () => {
  it('writes daily JSONL with private permissions', async () => {
    root = mkdtempSync(join(tmpdir(), 'kode-audit-test-'));
    const sink = new JsonlAuditSink(root);
    const timestamp = '2026-07-24T10:00:00.000Z';
    await sink.write({
      timestamp,
      runId: 'run-1',
      cwd: '/repo',
      tool: 'read_file',
      decision: 'allow',
      source: 'builtin',
      scope: 'config',
      inputSummary: '{"path":"a"}',
      outcome: 'ok',
    });
    const file = join(root, 'audit-2026-07-24.jsonl');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ runId: 'run-1' });
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('redacts content and common command secrets', () => {
    const summary = summarizePermissionInput({
      path: 'a.txt',
      content: 'private source',
      command: 'TOKEN=abc tool --api-key xyz',
    });
    expect(summary).not.toContain('private source');
    expect(summary).not.toContain('abc');
    expect(summary).not.toContain('xyz');
    expect(summary).toContain('[REDACTED]');
  });
});
