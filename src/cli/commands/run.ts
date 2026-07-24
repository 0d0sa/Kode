import * as readline from 'node:readline';
import { ConfigError } from '../../config/errors.js';
import { ProviderConfigError } from '../../llm/index.js';
import { askReadline } from '../readline.js';
import { createSession } from '../session.js';

export interface RunOptions {
  yes?: boolean;
  debug?: boolean;
}

/**
 * One-shot mode: run a single prompt and exit.
 * Approvals: --yes auto-approves; a TTY prompts inline; otherwise everything
 * requiring confirmation is denied (denial is reported back to the model).
 */
export async function runOnce(cwd: string, prompt: string, opts: RunOptions): Promise<number> {
  const interactive = !opts.yes && Boolean(process.stdin.isTTY);
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const ask = rl
    ? (question: string, signal?: AbortSignal) => askReadline(rl, question, signal)
    : undefined;

  let session: ReturnType<typeof createSession>;
  try {
    session = createSession(cwd, {
      ...(opts.yes !== undefined ? { autoApprove: opts.yes } : {}),
      interactive,
      ...(ask ? { ask } : {}),
      ...(opts.debug !== undefined ? { debug: opts.debug } : {}),
    });
  } catch (e) {
    rl?.close();
    return fail(e);
  }

  const onSigint = () => {
    if (!session.interrupt()) process.exit(130);
  };
  process.on('SIGINT', onSigint);
  try {
    const result = await session.runTurn(prompt);
    if (result.reason === 'aborted') return 130;
    if (!result.ok) return 1;
    return 0;
  } finally {
    process.removeListener('SIGINT', onSigint);
    await session.close();
    rl?.close();
  }
}

function fail(e: unknown): number {
  if (e instanceof ProviderConfigError || e instanceof ConfigError) {
    console.error(e.message);
    return 1;
  }
  console.error(`Unexpected error: ${(e as Error).message} (see ~/.kode/logs/ for details)`);
  return 2;
}
