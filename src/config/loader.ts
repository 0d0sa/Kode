import { readFileSync } from 'node:fs';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { ConfigSchema, type Config } from './schema.js';
import { ConfigError } from './errors.js';

function readJsonc(file: string): Record<string, unknown> {
  const text = readFileSync(file, 'utf8');
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0];
    throw new ConfigError(
      `${file}: JSONC parse error (code ${first.error} at offset ${first.offset}, length ${first.length})`,
      [file],
    );
  }
  return (value ?? {}) as Record<string, unknown>;
}

export interface LoadResult {
  config: Config;
  files: string[];
}

/**
 * Merge a list of config files (closest-first as returned by `findConfigFiles`)
 * using shallow per-key override: farther files form the base, nearer files
 * override top-level keys entirely. Arrays are replaced, not concatenated.
 *
 * Phase 0 intentionally uses shallow merge; deep merge is a documented future
 * upgrade (see docs/Phase0.md §6.2).
 */
export function loadConfig(files: string[]): LoadResult {
  if (files.length === 0) {
    const parsed = ConfigSchema.safeParse({});
    if (!parsed.success) {
      // Unreachable: empty input always satisfies the schema (all keys optional
      // except `version`, which has a default).
      throw new ConfigError('Default config failed to parse', []);
    }
    return { config: parsed.data, files: [] };
  }

  // Apply farthest-first: reverse so the closest file wins on per-key override.
  const ordered = [...files].reverse();
  let merged: Record<string, unknown> = {};
  for (const file of ordered) {
    const raw = readJsonc(file);
    merged = { ...merged, ...raw };
  }

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Config validation failed: ${detail}`, files);
  }

  return { config: parsed.data, files };
}