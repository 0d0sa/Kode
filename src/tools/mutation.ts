import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { UndoGroup, UndoSnapshot, UndoStore } from './undo/types.js';

const MAX_UNDO_GROUP_BYTES = 100 * 1024 * 1024;

export interface FileMutation {
  path: string;
  content: Buffer | null;
  expectedSha256?: string;
  createDirectories?: boolean;
}

export interface MutationResult {
  undoId: string;
  files: Array<{
    path: string;
    created: boolean;
    bytes: number;
    beforeSha256?: string;
    afterSha256?: string;
  }>;
}

interface PreparedMutation {
  mutation: FileMutation;
  snapshot: UndoSnapshot;
  mode: number;
}

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Preflight every target, persist one undo group, then commit atomically per file.
 * A commit failure restores every target from the in-memory snapshots.
 */
export async function applyFileMutations(options: {
  cwd: string;
  runId: string;
  toolCallId?: string;
  mutations: FileMutation[];
  signal: AbortSignal;
  undoStore: UndoStore;
  onCommitted?: (paths: readonly string[]) => void;
}): Promise<MutationResult> {
  throwIfAborted(options.signal);
  if (!options.mutations.length) throw new Error('No file mutations were requested');

  const unique = new Set(options.mutations.map((mutation) => mutation.path));
  if (unique.size !== options.mutations.length) {
    throw new Error('A mutation group cannot target the same path more than once');
  }

  const prepared = await Promise.all(options.mutations.map(prepareMutation));
  const snapshotBytes = prepared.reduce(
    (total, item) => total + (item.snapshot.content?.length ?? 0),
    0,
  );
  if (snapshotBytes > MAX_UNDO_GROUP_BYTES) {
    throw new Error(`Undo snapshot group exceeds the ${MAX_UNDO_GROUP_BYTES}-byte safety limit`);
  }
  throwIfAborted(options.signal);
  const group: UndoGroup = {
    id: `${Date.now()}-${randomUUID()}`,
    cwd: options.cwd,
    runId: options.runId,
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    createdAt: new Date().toISOString(),
    snapshots: prepared.map(({ snapshot, mutation }) => ({
      ...snapshot,
      ...(mutation.content ? { afterSha256: sha256(mutation.content) } : {}),
    })),
  };
  await options.undoStore.save(group);

  const committed: UndoSnapshot[] = [];
  try {
    throwIfAborted(options.signal);
    for (const [index, item] of prepared.entries()) {
      throwIfAborted(options.signal);
      await verifyUnchanged(item);
      await commitMutation(item);
      const snapshot = group.snapshots[index];
      if (snapshot) committed.push(snapshot);
    }
  } catch (error) {
    let rollbackError: unknown;
    try {
      await restoreSnapshots(committed, true);
    } catch (caught) {
      rollbackError = caught;
    }
    await options.undoStore.markUndone(group).catch(() => undefined);
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'File mutation failed and could not be rolled back completely',
      );
    }
    throw error;
  }

  const result: MutationResult = {
    undoId: group.id,
    files: prepared.map(({ mutation, snapshot }) => ({
      path: mutation.path,
      created: !snapshot.existed,
      bytes: mutation.content?.length ?? 0,
      ...(snapshot.beforeSha256 ? { beforeSha256: snapshot.beforeSha256 } : {}),
      ...(mutation.content ? { afterSha256: sha256(mutation.content) } : {}),
    })),
  };
  options.onCommitted?.(result.files.map((file) => file.path));
  return result;
}

export async function undoLatest(
  cwd: string,
  store: UndoStore,
  signal: AbortSignal,
  onCommitted?: (paths: readonly string[]) => void,
): Promise<UndoGroup | null> {
  throwIfAborted(signal);
  const group = await store.latest(cwd);
  if (!group) return null;

  for (const snapshot of group.snapshots) {
    throwIfAborted(signal);
    const current = await readFile(snapshot.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (snapshot.afterSha256) {
      if (!current || sha256(current) !== snapshot.afterSha256) {
        throw new Error(`Cannot undo because ${snapshot.path} changed after the edit`);
      }
    } else if (current) {
      throw new Error(`Cannot undo because ${snapshot.path} exists unexpectedly`);
    }
  }

  throwIfAborted(signal);
  await restoreSnapshots(group.snapshots);
  await store.markUndone(group);
  onCommitted?.(group.snapshots.map((snapshot) => snapshot.path));
  return group;
}

async function prepareMutation(mutation: FileMutation): Promise<PreparedMutation> {
  const fileStat = await lstat(mutation.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (fileStat && !fileStat.isFile()) throw new Error(`${mutation.path} is not a regular file`);
  const content = fileStat ? await readFile(mutation.path) : undefined;
  const beforeSha256 = content ? sha256(content) : undefined;
  if (mutation.expectedSha256 !== undefined && mutation.expectedSha256 !== beforeSha256) {
    throw new Error(
      `Conflict: ${mutation.path} changed since it was read (expected ${mutation.expectedSha256}, found ${beforeSha256 ?? 'missing'})`,
    );
  }
  if (!fileStat && !mutation.createDirectories) {
    const parent = await lstat(dirname(mutation.path)).catch(() => null);
    if (!parent?.isDirectory()) {
      throw new Error(`Parent directory does not exist for ${mutation.path}`);
    }
  }
  return {
    mutation,
    mode: fileStat?.mode ?? 0o644,
    snapshot: {
      path: mutation.path,
      existed: Boolean(fileStat),
      ...(fileStat ? { mode: fileStat.mode } : {}),
      ...(content ? { content } : {}),
      ...(beforeSha256 ? { beforeSha256 } : {}),
    },
  };
}

async function commitMutation(item: PreparedMutation): Promise<void> {
  const { mutation } = item;
  if (mutation.content === null) {
    await unlink(mutation.path);
    return;
  }
  if (mutation.createDirectories) {
    await mkdir(dirname(mutation.path), { recursive: true });
  }
  await atomicWrite(mutation.path, mutation.content, item.mode);
}

async function verifyUnchanged(item: PreparedMutation): Promise<void> {
  const current = await readFile(item.mutation.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!item.snapshot.existed) {
    if (current) throw new Error(`Conflict: ${item.mutation.path} was created before the write`);
    return;
  }
  if (!current || sha256(current) !== item.snapshot.beforeSha256) {
    throw new Error(`Conflict: ${item.mutation.path} changed immediately before the write`);
  }
}

async function restoreSnapshots(
  snapshots: UndoSnapshot[],
  verifyAppliedState = false,
): Promise<void> {
  const errors: Error[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      if (verifyAppliedState) await verifySnapshotApplied(snapshot);
      if (!snapshot.existed) {
        await unlink(snapshot.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      } else if (snapshot.content) {
        await mkdir(dirname(snapshot.path), { recursive: true });
        await atomicWrite(snapshot.path, snapshot.content, snapshot.mode ?? 0o644);
      }
    } catch (error) {
      errors.push(error as Error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Failed to restore one or more files');
}

async function verifySnapshotApplied(snapshot: UndoSnapshot): Promise<void> {
  const current = await readFile(snapshot.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (snapshot.afterSha256) {
    if (!current || sha256(current) !== snapshot.afterSha256) {
      throw new Error(`Cannot roll back ${snapshot.path} because it changed after the write`);
    }
  } else if (current) {
    throw new Error(`Cannot roll back ${snapshot.path} because it was recreated`);
  }
}

async function atomicWrite(path: string, content: Buffer, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.kode-tmp`);
  try {
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}
