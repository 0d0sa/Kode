import type { Interface } from 'node:readline';

/** Ask one readline question, resolving cleanly on EOF or AbortSignal. */
export function askReadline(
  rl: Interface,
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (answer: string) => {
      if (settled) return;
      settled = true;
      rl.removeListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      resolve(answer);
    };
    const onClose = () => finish('/exit');
    const onAbort = () => finish('');

    rl.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      finish('');
      return;
    }
    rl.question(question, signal ? { signal } : {}, finish);
  });
}
