import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pkgVersion = '0.0.0';
try {
  const raw = require('../package.json') as { version?: string } | undefined;
  if (raw?.version) pkgVersion = raw.version;
} catch {
  // Bundled/compiled scenarios where package.json is not resolvable at runtime.
}

export const VERSION: string = pkgVersion;
