export type PermissionDecision = 'allow' | 'confirm' | 'deny';
export type PermissionKind = 'read' | 'write' | 'execute';

export interface PermissionPath {
  canonical: string;
  relative: string;
  outsideWorkspace: boolean;
  recursive?: boolean;
}

export interface ToolPermission {
  kind: PermissionKind;
  paths?: PermissionPath[];
  command?: string;
}

export interface PolicyRequest {
  tool: string;
  permission: ToolPermission;
}

export type PolicySource = 'builtin' | 'config' | 'session' | 'user';

export interface PolicyResult {
  decision: PermissionDecision;
  source: PolicySource;
  reason: string;
  scopeKeys: string[];
}

export interface AuditEvent {
  timestamp: string;
  runId: string;
  cwd: string;
  tool: string;
  decision: PermissionDecision;
  source: PolicySource;
  scope: 'once' | 'session' | 'config';
  inputSummary: string;
  outcome?: 'ok' | 'error' | 'aborted';
  durationMs?: number;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}
