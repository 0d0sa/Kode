import { Command } from 'commander';
import { VERSION } from '../version.js';
import { printResolvedConfig } from './commands/config.js';
import { replStub } from './commands/repl.js';

export const program = new Command();

program
  .name('kode')
  .description('A local coding agent.')
  .version(VERSION, '-v, --version');

program
  .command('config')
  .description('Print resolved config and discovery trace')
  .action(() => printResolvedConfig(process.cwd()));

program
  .command('repl')
  .description('Start interactive REPL (coming in Phase 1)')
  .action(() => replStub());