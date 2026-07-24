import * as readline from 'node:readline';
import { ConfigError } from '../../config/errors.js';
import { ProviderConfigError } from '../../llm/index.js';
import { VERSION } from '../../version.js';
import { askReadline } from '../readline.js';
import { createSession } from '../session.js';

const HELP = `Commands:
  /help   Show this help
  /clear  Clear conversation history
  /undo   Restore the latest file edit group
  /exit   Exit (also: /quit, Ctrl-C when idle)
Anything else is sent to the agent.`;

export async function startRepl(cwd: string, opts: { debug?: boolean } = {}): Promise<number> {
  let session: ReturnType<typeof createSession>;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string, signal?: AbortSignal) => askReadline(rl, question, signal);
  try {
    session = createSession(cwd, {
      interactive: true,
      ask,
      ...(opts.debug !== undefined ? { debug: opts.debug } : {}),
    });
  } catch (e) {
    rl.close();
    return fail(e);
  }

  console.log(`kode ${VERSION} — ${session.model()}. /help for commands, /exit to quit.`);
  rl.on('SIGINT', () => {
    if (!session.interrupt()) {
      rl.close();
      process.exit(130);
    }
  });

  // Sequential prompt loop (readline question callbacks don't overlap).
  while (true) {
    const line = (await ask('> ')).trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;
    if (line === '/help') {
      console.log(HELP);
      continue;
    }
    if (line === '/clear') {
      session.clearHistory();
      console.log('History cleared.');
      continue;
    }
    if (line === '/undo') {
      await session.undoLast();
      continue;
    }
    if (line.startsWith('/')) {
      console.log(`Unknown command: ${line}. /help for commands.`);
      continue;
    }
    await session.runTurn(line);
  }
  await session.close();
  rl.close();
  return 0;
}

function fail(e: unknown): number {
  if (e instanceof ProviderConfigError || e instanceof ConfigError) {
    console.error(e.message);
    return 1;
  }
  console.error(`Unexpected error: ${(e as Error).message} (see ~/.kode/logs/ for details)`);
  return 2;
}
