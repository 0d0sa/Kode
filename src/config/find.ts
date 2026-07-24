import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export const CONFIG_FILENAME = 'kode.jsonc';

export function homeConfigPath(): string {
  return join(homedir(), '.kode', 'kode.jsonc');
}

/**
 * Discover `kode.jsonc` files.
 *
 * Order of returned list (closest-first):
 *   1. cwd -> parent -> ... up to filesystem root
 *   2. ~/.kode/kode.jsonc (global fallback), if present
 *
 * The caller is expected to apply them farthest-first (home as base, closest
 * last) so that nearer files override farther ones. See `loadConfig`.
 */
export function findConfigFiles(cwd: string): string[] {
  const found: string[] = [];
  const start = isAbsolute(cwd) ? cwd : join(process.cwd(), cwd);

  let dir = start;
  // guard against platforms where dirname(root) === root
  let prev: string | undefined;
  while (dir !== prev) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) found.push(candidate);
    prev = dir;
    dir = dirname(dir);
  }

  const home = homeConfigPath();
  if (existsSync(home)) found.push(home);

  return found;
}