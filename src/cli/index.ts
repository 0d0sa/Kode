import { Command } from 'commander';
import { VERSION } from '../version.js';
import { printResolvedConfig } from './commands/config.js';
import { startRepl } from './commands/repl.js';
import { runOnce } from './commands/run.js';

export const program = new Command();

program.name('kode').description('A local coding agent.').version(VERSION, '-v, --version');

program
  .command('config')
  .description('Print resolved config and discovery trace')
  .action(() => printResolvedConfig(process.cwd()));

program
  .command('repl')
  .description('Start interactive REPL')
  .action(async () => {
    process.exitCode = await startRepl(process.cwd());
  });

program
  .command('run')
  .description('Run a single prompt and exit')
  .argument('<prompt>', 'Prompt to run')
  .option('-y, --yes', 'Auto-approve all tool confirmations (use with care)')
  .action(async (prompt: string, opts: { yes?: boolean }) => {
    process.exitCode = await runOnce(process.cwd(), prompt, opts);
  });

// Bare `kode` starts the REPL.
program.action(async () => {
  process.exitCode = await startRepl(process.cwd());
});
