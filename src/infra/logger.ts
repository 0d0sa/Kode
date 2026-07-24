import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../version.js';

const logDir = join(homedir(), '.kode', 'logs');
mkdirSync(logDir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 10);
const dest = pino.destination(join(logDir, `kode-${stamp}.log`));

// Env wins over (future) config file setting; Phase 0 only reads env.
const level = process.env.KODE_LOG_LEVEL ?? 'info';

export const logger = pino(
  {
    level,
    base: { version: VERSION },
  },
  dest,
);

export const childLogger = (component: string) => logger.child({ component });