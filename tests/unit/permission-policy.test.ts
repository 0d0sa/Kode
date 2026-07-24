import { describe, expect, it } from 'vitest';
import { evaluatePolicy, isSimpleCommand } from '../../src/permission/policy.js';
import type { PermissionPath } from '../../src/permission/types.js';

const inside: PermissionPath = {
  canonical: '/repo/src/a.ts',
  relative: 'src/a.ts',
  outsideWorkspace: false,
};
const outside: PermissionPath = {
  canonical: '/secret/a.txt',
  relative: '/secret/a.txt',
  outsideWorkspace: true,
};

describe('permission policy', () => {
  it('uses the first matching rule and preserves deny over session grants', () => {
    const permissions = {
      rules: [
        { id: 'deny-src', decision: 'deny' as const, paths: ['src/**'] },
        { id: 'allow-all', decision: 'allow' as const, paths: ['**/*'] },
      ],
    };
    const result = evaluatePolicy(
      { tool: 'write_file', permission: { kind: 'write', paths: [inside] } },
      permissions,
      () => true,
    );
    expect(result).toMatchObject({ decision: 'deny', source: 'config' });
  });

  it('allows workspace reads but confirms outside paths even with a legacy allow override', () => {
    const local = evaluatePolicy(
      { tool: 'read_file', permission: { kind: 'read', paths: [inside] } },
      {},
      () => false,
    );
    const external = evaluatePolicy(
      { tool: 'read_file', permission: { kind: 'read', paths: [outside] } },
      { overrides: { read_file: 'allow' as const } },
      () => false,
    );
    expect(local.decision).toBe('allow');
    expect(external.decision).toBe('confirm');
  });

  it('only applies command prefixes to simple commands', () => {
    const permissions = {
      rules: [
        {
          id: 'tests',
          decision: 'allow' as const,
          tools: ['run_command'],
          commandPrefixes: ['pnpm test'],
        },
      ],
    };
    const simple = evaluatePolicy(
      { tool: 'run_command', permission: { kind: 'execute', command: 'pnpm   test unit' } },
      permissions,
      () => false,
    );
    const compound = evaluatePolicy(
      { tool: 'run_command', permission: { kind: 'execute', command: 'pnpm test && echo done' } },
      permissions,
      () => false,
    );
    expect(simple.decision).toBe('allow');
    expect(compound.decision).toBe('confirm');
    expect(isSimpleCommand('pnpm test')).toBe(true);
    expect(isSimpleCommand('echo $TOKEN')).toBe(false);
    expect(isSimpleCommand('bash -c "pnpm test"')).toBe(false);
    expect(isSimpleCommand('env bash -lc "pnpm test"')).toBe(false);
  });
});
