import { config as dotenvConfig } from 'dotenv';
import { logger } from '../infra/logger.js';

/**
 * Programmatically load env files so users can run `kode` directly (no need to
 * prefix with a shell env loader). `.env.local` takes precedence over `.env`.
 */
export function loadEnv(cwd: string): void {
  dotenvConfig({ path: [`${cwd}/.env.local`, `${cwd}/.env`] });
}

/**
 * Returns true if the referenced env var is set; warns (once) when missing.
 * Phase 0 does not hard-fail because no LLM call consumes the key yet. Phase 1
 * will introduce stricter enforcement at request time.
 */
export function assertApiKey(envName: string | undefined): boolean {
  if (!envName) return true;
  const present = Boolean(process.env[envName]);
  if (!present) {
    logger.warn({ envName }, 'Referenced API key env var is not set');
  }
  return present;
}
