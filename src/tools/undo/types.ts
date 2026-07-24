export interface UndoSnapshot {
  path: string;
  existed: boolean;
  mode?: number;
  content?: Buffer;
  beforeSha256?: string;
  afterSha256?: string;
}

export interface UndoGroup {
  id: string;
  cwd: string;
  runId: string;
  toolCallId?: string;
  createdAt: string;
  snapshots: UndoSnapshot[];
}

export interface UndoStore {
  save(group: UndoGroup): Promise<string>;
  latest(cwd: string): Promise<UndoGroup | null>;
  markUndone(group: UndoGroup): Promise<void>;
}
