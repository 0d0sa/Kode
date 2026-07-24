import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyFileMutations, sha256, undoLatest } from '../../src/tools/mutation.js';
import { FileUndoStore, MemoryUndoStore } from '../../src/tools/undo/store.js';

let workdir: string;
let store: MemoryUndoStore;
const signal = new AbortController().signal;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'kode-mutation-test-'));
  store = new MemoryUndoStore();
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('file mutation service', () => {
  it('atomically writes a group and undo restores overwritten and new files', async () => {
    const existing = join(workdir, 'a.txt');
    const created = join(workdir, 'b.txt');
    writeFileSync(existing, 'old');
    chmodSync(existing, 0o640);
    const result = await applyFileMutations({
      cwd: workdir,
      runId: 'run-1',
      toolCallId: 'tool-1',
      mutations: [
        { path: existing, content: Buffer.from('new'), expectedSha256: sha256('old') },
        { path: created, content: Buffer.from('created') },
      ],
      signal,
      undoStore: store,
    });
    expect(result.files).toHaveLength(2);
    expect(store.groups[0]?.toolCallId).toBe('tool-1');
    expect(readFileSync(existing, 'utf8')).toBe('new');
    expect(readFileSync(created, 'utf8')).toBe('created');

    const group = await undoLatest(workdir, store, signal);
    expect(group?.id).toBe(result.undoId);
    expect(readFileSync(existing, 'utf8')).toBe('old');
    expect(() => readFileSync(created)).toThrow();
    expect(statSync(existing).mode & 0o777).toBe(0o640);
  });

  it('rejects stale hashes without writing or recording undo', async () => {
    const path = join(workdir, 'a.txt');
    writeFileSync(path, 'current');
    await expect(
      applyFileMutations({
        cwd: workdir,
        runId: 'run-1',
        mutations: [{ path, content: Buffer.from('new'), expectedSha256: sha256('stale') }],
        signal,
        undoStore: store,
      }),
    ).rejects.toThrow(/Conflict/);
    expect(readFileSync(path, 'utf8')).toBe('current');
    expect(store.groups).toHaveLength(0);
  });

  it('notifies the index only after a mutation group commits', async () => {
    const path = join(workdir, 'notify.txt');
    writeFileSync(path, 'before');
    const changed: string[][] = [];
    await applyFileMutations({
      cwd: workdir,
      runId: 'run',
      mutations: [
        {
          path,
          content: Buffer.from('after'),
          expectedSha256: sha256('before'),
        },
      ],
      signal,
      undoStore: store,
      onCommitted: (paths) => changed.push([...paths]),
    });
    expect(changed).toEqual([[path]]);
  });

  it('refuses undo when a file changed after the mutation', async () => {
    const path = join(workdir, 'a.txt');
    writeFileSync(path, 'old');
    await applyFileMutations({
      cwd: workdir,
      runId: 'run-1',
      mutations: [{ path, content: Buffer.from('new'), expectedSha256: sha256('old') }],
      signal,
      undoStore: store,
    });
    writeFileSync(path, 'user edit');
    await expect(undoLatest(workdir, store, signal)).rejects.toThrow(/changed after the edit/);
    expect(readFileSync(path, 'utf8')).toBe('user edit');
  });

  it('persists and consumes undo snapshots in a global-style store', async () => {
    const undoRoot = join(workdir, 'undo-root');
    const fileStore = new FileUndoStore(undoRoot);
    const path = join(workdir, 'a.txt');
    writeFileSync(path, 'old');
    await applyFileMutations({
      cwd: workdir,
      runId: 'run-1',
      mutations: [{ path, content: Buffer.from('new'), expectedSha256: sha256('old') }],
      signal,
      undoStore: fileStore,
    });
    expect((await fileStore.latest(workdir))?.snapshots[0]?.content?.toString()).toBe('old');
    await undoLatest(workdir, fileStore, signal);
    expect(readFileSync(path, 'utf8')).toBe('old');
    expect(await fileStore.latest(workdir)).toBeNull();
    expect(statSync(undoRoot).mode & 0o777).toBe(0o700);
  });
});
