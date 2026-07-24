import type { PermissionRule, Permissions } from '../config/schema.js';
import { toPosixPath } from '../tools/path.js';
import { normalizeCommand, scopeKeysFor } from './scope.js';
import type {
  PermissionDecision,
  PermissionPath,
  PolicyRequest,
  PolicyResult,
  PolicySource,
} from './types.js';

interface Subject {
  path?: PermissionPath;
  command?: string;
  scopeKey: string;
}

interface SubjectDecision {
  decision: PermissionDecision;
  source: Exclude<PolicySource, 'user'>;
  reason: string;
  scopeKey: string;
}

const DECISION_WEIGHT: Record<PermissionDecision, number> = {
  allow: 0,
  confirm: 1,
  deny: 2,
};

/** Pure Phase 2 policy evaluation. Explicit deny can never be bypassed by a session grant. */
export function evaluatePolicy(
  request: PolicyRequest,
  permissions: Permissions,
  isSessionApproved: (scopeKey: string) => boolean,
): PolicyResult {
  const scopeKeys = scopeKeysFor(request);
  const paths = request.permission.paths;
  const subjects: Subject[] = paths?.length
    ? paths.map((path, index) => ({ path, scopeKey: scopeKeys[index] ?? scopeKeys[0] ?? '' }))
    : [
        {
          ...(request.permission.command ? { command: request.permission.command } : {}),
          scopeKey: scopeKeys[0] ?? `${request.tool}|tool`,
        },
      ];

  const decisions = subjects.map((subject) =>
    evaluateSubject(request, subject, permissions, isSessionApproved),
  );
  const strongest = decisions.reduce((current, next) =>
    DECISION_WEIGHT[next.decision] > DECISION_WEIGHT[current.decision] ? next : current,
  );

  return {
    decision: strongest.decision,
    source: strongest.source,
    reason:
      decisions.length === 1
        ? strongest.reason
        : `${strongest.reason} (${decisions.length} permission targets evaluated)`,
    scopeKeys: decisions
      .filter((decision) => decision.decision === 'confirm')
      .map((decision) => decision.scopeKey),
  };
}

function evaluateSubject(
  request: PolicyRequest,
  subject: Subject,
  permissions: Permissions,
  isSessionApproved: (scopeKey: string) => boolean,
): SubjectDecision {
  const rule = permissions.rules?.find((candidate) =>
    ruleMatches(candidate, request.tool, subject),
  );
  const configured = rule
    ? {
        decision: rule.decision,
        source: 'config' as const,
        reason: `Matched permission rule "${rule.id}"`,
      }
    : configuredFallback(request, subject, permissions);

  if (configured.decision !== 'confirm') {
    return { ...configured, scopeKey: subject.scopeKey };
  }
  if (isSessionApproved(subject.scopeKey)) {
    return {
      decision: 'allow',
      source: 'session',
      reason: 'Allowed by session-scoped approval',
      scopeKey: subject.scopeKey,
    };
  }
  return { ...configured, scopeKey: subject.scopeKey };
}

function configuredFallback(
  request: PolicyRequest,
  subject: Subject,
  permissions: Permissions,
): Omit<SubjectDecision, 'scopeKey'> {
  if (subject.path?.outsideWorkspace) {
    return {
      decision: 'confirm',
      source: 'builtin',
      reason: 'Target is outside the workspace',
    };
  }
  const override = permissions.overrides?.[request.tool];
  if (override) {
    return {
      decision: override,
      source: 'config',
      reason: `Configured override for ${request.tool}`,
    };
  }
  if (request.permission.kind === 'read') {
    return { decision: 'allow', source: 'builtin', reason: 'Workspace read is allowed' };
  }
  return {
    decision: permissions.default ?? 'confirm',
    source: permissions.default ? 'config' : 'builtin',
    reason: permissions.default ? 'Configured default decision' : 'Writes and commands confirm',
  };
}

function ruleMatches(rule: PermissionRule, tool: string, subject: Subject): boolean {
  if (rule.tools && !rule.tools.includes(tool) && !rule.tools.includes('*')) return false;
  if (rule.paths) {
    if (!subject.path) return false;
    const value = subject.path.outsideWorkspace
      ? toPosixPath(subject.path.canonical)
      : toPosixPath(subject.path.relative);
    if (!rule.paths.some((pattern) => globMatches(pattern, value))) return false;
  }
  if (rule.commandPrefixes) {
    if (!subject.command || !isSimpleCommand(subject.command)) return false;
    const command = normalizeCommand(subject.command);
    if (
      !rule.commandPrefixes.some((prefix) => {
        const normalized = normalizeCommand(prefix);
        return command === normalized || command.startsWith(`${normalized} `);
      })
    ) {
      return false;
    }
  }
  return true;
}

/** Conservative: compound shell syntax never qualifies for prefix auto-allow. */
export function isSimpleCommand(command: string): boolean {
  if (/[|&;<>()`$\\\n\r]/.test(command)) return false;
  const parts = normalizeCommand(command).split(' ');
  for (const [index, part] of parts.entries()) {
    const executable = part?.split('/').at(-1);
    if (!executable || !['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'].includes(executable)) {
      continue;
    }
    if (
      parts
        .slice(index + 1)
        .some(
          (argument) =>
            argument === '--command' ||
            argument.startsWith('--command=') ||
            (/^-[^-]*c/.test(argument) && argument !== '-'),
        )
    ) {
      return false;
    }
  }
  return true;
}

/** Small permission-only glob matcher: `*`, `**`, and `?`, always slash-normalized. */
function globMatches(pattern: string, value: string): boolean {
  const source = toPosixPath(pattern);
  let regex = '^';
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '*') {
      if (source[i + 1] === '*') {
        i++;
        if (source[i + 1] === '/') {
          i++;
          regex += '(?:.*/)?';
        } else {
          regex += '.*';
        }
      } else {
        regex += '[^/]*';
      }
    } else if (char === '?') {
      regex += '[^/]';
    } else {
      regex += char?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
    }
  }
  return new RegExp(`${regex}$`).test(value);
}
