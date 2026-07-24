import { appendFile, chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent, AuditSink } from './types.js';

const MAX_AUDIT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class JsonlAuditSink implements AuditSink {
  constructor(private root = join(homedir(), '.kode', 'audit')) {}

  async write(event: AuditEvent): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    const day = event.timestamp.slice(0, 10);
    const file = join(this.root, `audit-${day}.jsonl`);
    await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(file, 0o600);
    await this.prune(event.timestamp);
  }

  private async prune(now: string): Promise<void> {
    const cutoff = new Date(new Date(now).getTime() - MAX_AUDIT_AGE_MS).toISOString().slice(0, 10);
    const files = await readdir(this.root);
    await Promise.all(
      files
        .filter((file) => {
          const match = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
          return Boolean(match?.[1] && match[1] < cutoff);
        })
        .map((file) => rm(join(this.root, file), { force: true })),
    );
  }
}

export class MemoryAuditSink implements AuditSink {
  events: AuditEvent[] = [];

  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
