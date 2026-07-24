import type { Config } from '../config/schema.js';

export function resolveLogLevel(
  configLevel: Config['logLevel'],
  envLevel: string | undefined,
): string {
  return envLevel ?? configLevel ?? 'info';
}
