import { findConfigFiles } from '../../config/find.js';
import { loadConfig } from '../../config/loader.js';
import { loadEnv, assertApiKey } from '../../config/env.js';
import { logger } from '../../infra/logger.js';

export function printResolvedConfig(cwd: string): void {
  loadEnv(cwd);
  const files = findConfigFiles(cwd);
  logger.debug({ cwd, files }, 'config discovery');

  try {
    const { config } = loadConfig(files);
    console.log('Config files (closest first):');
    if (files.length === 0) {
      console.log('  (none found, using defaults)');
    }
    for (const f of files) console.log(`  ${f}`);
    console.log('\nResolved config:');
    console.log(JSON.stringify(config, null, 2));

    if (config.model?.apiKeyEnv) {
      const present = assertApiKey(config.model.apiKeyEnv);
      console.log(`\nAPI key (${config.model.apiKeyEnv}): ${present ? 'present' : 'MISSING'}`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}