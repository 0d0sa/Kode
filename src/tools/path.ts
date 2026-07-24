import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface ResolvedToolPath {
  input: string;
  absolute: string;
  canonical: string;
  workspaceRoot: string;
  relative: string;
  exists: boolean;
  outsideWorkspace: boolean;
}

export interface ResolveToolPathOptions {
  allowMissing?: boolean;
}

/** Resolve a tool path through symlinks and classify it against the session workspace. */
export async function resolveToolPath(
  cwd: string,
  input: string,
  options: ResolveToolPathOptions = {},
): Promise<ResolvedToolPath> {
  if (!input || input.includes('\0')) throw new Error('Path must be a non-empty string');

  const workspaceRoot = await realpath(cwd);
  const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  const resolved = await canonicalize(absolute, options.allowMissing ?? false);
  const rel = relative(workspaceRoot, resolved.canonical);
  const outsideWorkspace = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);

  return {
    input,
    absolute,
    canonical: resolved.canonical,
    workspaceRoot,
    relative: outsideWorkspace ? resolved.canonical : rel || '.',
    exists: resolved.exists,
    outsideWorkspace,
  };
}

async function canonicalize(
  absolute: string,
  allowMissing: boolean,
): Promise<{ canonical: string; exists: boolean }> {
  try {
    return { canonical: await realpath(absolute), exists: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw e;
  }

  const missing: string[] = [];
  let cursor = absolute;
  while (true) {
    try {
      await lstat(cursor);
      const ancestor = await realpath(cursor);
      return { canonical: resolve(ancestor, ...missing.reverse()), exists: false };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = dirname(cursor);
      if (parent === cursor) throw e;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

/** Detect a symlink/path race between registry permission evaluation and execution. */
export function assertAuthorizedToolPath(
  authorizedPaths: ReadonlySet<string> | undefined,
  canonical: string,
): void {
  if (authorizedPaths && !authorizedPaths.has(canonical)) {
    throw new Error(`Path changed after permission approval: ${canonical}`);
  }
}
