import { toPosixPath } from '../tools/path.js';
import type { PermissionPath, PolicyRequest } from './types.js';

export function scopeKeysFor(request: PolicyRequest): string[] {
  const paths = request.permission.paths;
  if (paths?.length) return paths.map((path) => pathScopeKey(request.tool, path));
  if (request.permission.command) {
    return [`${request.tool}|command:${normalizeCommand(request.permission.command)}`];
  }
  return [`${request.tool}|tool`];
}

function pathScopeKey(tool: string, path: PermissionPath): string {
  return `${tool}|${path.recursive ? 'tree' : 'path'}:${toPosixPath(path.canonical)}`;
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}
