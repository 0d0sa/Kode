import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { UndoGroup, UndoSnapshot, UndoStore } from './types.js';

const MAX_GROUPS_PER_PROJECT = 100;
const MAX_GROUP_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredSnapshot extends Omit<UndoSnapshot, 'content'> {
  contentFile?: string;
}

interface StoredGroup extends Omit<UndoGroup, 'snapshots'> {
  snapshots: StoredSnapshot[];
}

export class FileUndoStore implements UndoStore {
  constructor(private root = join(homedir(), '.kode', 'undo')) {}

  async save(group: UndoGroup): Promise<string> {
    const projectRoot = await this.projectRoot(group.cwd);
    const groupRoot = join(projectRoot, group.id);
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await chmod(projectRoot, 0o700);
    await mkdir(groupRoot, { mode: 0o700 });
    await chmod(groupRoot, 0o700);

    const snapshots: StoredSnapshot[] = [];
    for (const [index, snapshot] of group.snapshots.entries()) {
      const contentFile = snapshot.content ? `${index}.bin` : undefined;
      if (contentFile && snapshot.content) {
        const contentPath = join(groupRoot, contentFile);
        await writeFile(contentPath, snapshot.content, { mode: 0o600 });
        await chmod(contentPath, 0o600);
      }
      snapshots.push({
        path: snapshot.path,
        existed: snapshot.existed,
        ...(snapshot.mode !== undefined ? { mode: snapshot.mode } : {}),
        ...(snapshot.beforeSha256 ? { beforeSha256: snapshot.beforeSha256 } : {}),
        ...(snapshot.afterSha256 ? { afterSha256: snapshot.afterSha256 } : {}),
        ...(contentFile ? { contentFile } : {}),
      });
    }

    const manifest: StoredGroup = {
      id: group.id,
      cwd: group.cwd,
      runId: group.runId,
      ...(group.toolCallId ? { toolCallId: group.toolCallId } : {}),
      createdAt: group.createdAt,
      snapshots,
    };
    const manifestPath = join(groupRoot, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(manifestPath, 0o600);
    await this.prune(projectRoot);
    return group.id;
  }

  async latest(cwd: string): Promise<UndoGroup | null> {
    const projectRoot = await this.projectRoot(cwd);
    const entries = await readdir(projectRoot, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    const candidates: UndoGroup[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.endsWith('.undone')) continue;
      const group = await this.readGroup(join(projectRoot, entry.name)).catch(() => null);
      if (group) candidates.push(group);
    }
    candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return candidates[0] ?? null;
  }

  async markUndone(group: UndoGroup): Promise<void> {
    const source = join(await this.projectRoot(group.cwd), group.id);
    await rename(source, `${source}.undone`);
  }

  private async projectRoot(cwd: string): Promise<string> {
    const canonical = await realpath(cwd).catch(() => resolve(cwd));
    const projectId = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    return join(this.root, projectId);
  }

  private async readGroup(groupRoot: string): Promise<UndoGroup> {
    const raw = await readFile(join(groupRoot, 'manifest.json'), 'utf8');
    const stored = JSON.parse(raw) as StoredGroup;
    const snapshots: UndoSnapshot[] = [];
    for (const snapshot of stored.snapshots) {
      const content = snapshot.contentFile
        ? await readFile(join(groupRoot, snapshot.contentFile))
        : undefined;
      snapshots.push({
        path: snapshot.path,
        existed: snapshot.existed,
        ...(snapshot.mode !== undefined ? { mode: snapshot.mode } : {}),
        ...(content ? { content } : {}),
        ...(snapshot.beforeSha256 ? { beforeSha256: snapshot.beforeSha256 } : {}),
        ...(snapshot.afterSha256 ? { afterSha256: snapshot.afterSha256 } : {}),
      });
    }
    return {
      id: stored.id,
      cwd: stored.cwd,
      runId: stored.runId,
      ...(stored.toolCallId ? { toolCallId: stored.toolCallId } : {}),
      createdAt: stored.createdAt,
      snapshots,
    };
  }

  private async prune(projectRoot: string): Promise<void> {
    const entries = await readdir(projectRoot, { withFileTypes: true });
    const directories = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => ({
          path: join(projectRoot, entry.name),
          mtimeMs: (await stat(join(projectRoot, entry.name))).mtimeMs,
        })),
    );
    directories.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const cutoff = Date.now() - MAX_GROUP_AGE_MS;
    await Promise.all(
      directories
        .filter((entry, index) => index >= MAX_GROUPS_PER_PROJECT || entry.mtimeMs < cutoff)
        .map((entry) => rm(entry.path, { recursive: true, force: true })),
    );
  }
}

export class MemoryUndoStore implements UndoStore {
  groups: UndoGroup[] = [];

  async save(group: UndoGroup): Promise<string> {
    this.groups.push(group);
    return group.id;
  }

  async latest(cwd: string): Promise<UndoGroup | null> {
    return [...this.groups].reverse().find((group) => group.cwd === cwd) ?? null;
  }

  async markUndone(group: UndoGroup): Promise<void> {
    this.groups = this.groups.filter((candidate) => candidate.id !== group.id);
  }
}
