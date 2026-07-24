import { loadEnv } from './config/env.js';
import { program } from './cli/index.js';

const cwd = process.cwd();
loadEnv(cwd);
await program.parseAsync(process.argv);