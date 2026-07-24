import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPatchTool } from '../../src/tools/edit/apply-patch.js';
import { writeFileTool } from '../../src/tools/fs/write.js';
import { sha256 } from '../../src/tools/mutation.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ToolContext } from '../../src/tools/types.js';
import { MemoryUndoStore } from '../../src/tools/undo/store.js';
import { testLogger } from './helpers.js';

let workdir: string;
let undoStore: MemoryUndoStore;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'kode-write-patch-test-'));
  undoStore = new MemoryUndoStore();
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
    runId: 'run-1',
    undoStore,
  };
}

describe('write_file and apply_patch', () => {
  it('creates a file and requires a hash for overwrite', async () => {
    const created = await writeFileTool.execute({ path: 'a.txt', content: 'one' }, ctx());
    expect(created.ok).toBe(true);
    expect(readFileSync(join(workdir, 'a.txt'), 'utf8')).toBe('one');

    const withoutHash = await writeFileTool.execute(
      { path: 'a.txt', content: 'two', overwrite: true },
      ctx(),
    );
    expect(withoutHash.ok).toBe(false);
    const overwritten = await writeFileTool.execute(
      {
        path: 'a.txt',
        content: 'two',
        overwrite: true,
        expected_sha256: sha256('one'),
      },
      ctx(),
    );
    expect(overwritten.ok).toBe(true);
    expect(readFileSync(join(workdir, 'a.txt'), 'utf8')).toBe('two');
  });

  it('dry-runs and applies a multi-file patch as one undo group', async () => {
    writeFileSync(join(workdir, 'a.txt'), 'old\n');
    const patch = `--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
--- /dev/null
+++ b/b.txt
@@ -0,0 +1 @@
+created
`;
    const result = await applyPatchTool.execute({ patch }, ctx());
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workdir, 'a.txt'), 'utf8')).toBe('new\n');
    expect(readFileSync(join(workdir, 'b.txt'), 'utf8')).toBe('created\n');
    expect(undoStore.groups).toHaveLength(1);
    expect(undoStore.groups[0]?.snapshots).toHaveLength(2);
  });

  it('does not modify any file when a later patch hunk fails', async () => {
    writeFileSync(join(workdir, 'a.txt'), 'old\n');
    writeFileSync(join(workdir, 'b.txt'), 'actual\n');
    const patch = `--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-expected
+changed
`;
    const result = await applyPatchTool.execute({ patch }, ctx());
    expect(result.ok).toBe(false);
    expect(readFileSync(join(workdir, 'a.txt'), 'utf8')).toBe('old\n');
    expect(readFileSync(join(workdir, 'b.txt'), 'utf8')).toBe('actual\n');
    expect(undoStore.groups).toHaveLength(0);
  });

  it('rejects patch path traversal', async () => {
    const patch = `--- a/../outside.txt
+++ b/../outside.txt
@@ -1 +1 @@
-old
+new
`;
    const result = await applyPatchTool.execute({ patch }, ctx());
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Unsafe patch path/);
  });

  it('permission preflight allows a patch that creates a new file', async () => {
    const registry = new ToolRegistry({ default: 'allow' });
    registry.register(applyPatchTool);
    const patch = `--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+new
`;
    const result = await registry.dispatch('apply_patch', { patch }, ctx());
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workdir, 'new.txt'), 'utf8')).toBe('new\n');
  });
});
