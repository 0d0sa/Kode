import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import { resolveLogLevel } from './log-level.js';
import { VERSION } from '../version.js';

const logDir = join(homedir(), '.kode', 'logs');
mkdirSync(logDir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 10);
const dest = pino.destination({
  dest: join(logDir, `kode-${stamp}.log`),
  sync: true,
});

// The shell environment is available during module initialization. Values from
// dotenv and kode.jsonc are applied later through `configureLogger`.
const level = resolveLogLevel(undefined, process.env.KODE_LOG_LEVEL);

export const logger = pino(
  {
    level,
    base: { version: VERSION },
  },
  dest,
);

export function configureLogger(configLevel?: Config['logLevel']): void {
  logger.level = resolveLogLevel(configLevel, process.env.KODE_LOG_LEVEL);
}

export const childLogger = (component: string) => logger.child({ component });
