import { findConfigFiles } from '../../config/find.js';
import { loadConfig } from '../../config/loader.js';
import { loadEnv, assertApiKey } from '../../config/env.js';
import { configureLogger, logger } from '../../infra/logger.js';

export function printResolvedConfig(cwd: string): void {
  loadEnv(cwd);
  const files = findConfigFiles(cwd);

  try {
    const { config } = loadConfig(files);
    configureLogger(config.logLevel);
    logger.info({ cwd, configFileCount: files.length }, 'config resolved');
    logger.debug({ cwd, files }, 'config discovery');

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
