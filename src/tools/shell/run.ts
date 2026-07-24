import { spawn } from 'node:child_process';
import { z } from 'zod';
import { toInputSchema, type Tool, type ToolResult } from '../types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const TAIL_LINES = 2000;
const TAIL_BYTES = 50 * 1024;

const schema = z.object({
  command: z.string().min(1).describe('bash command line to execute'),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in ms, default ${DEFAULT_TIMEOUT_MS}`),
});

export const runCommandTool: Tool<z.infer<typeof schema>> = {
  name: 'run_command',
  description:
    'Run a bash command in the working directory. Returns exit code and tail-truncated stdout/stderr. Use for builds, tests, lint, git status, etc.',
  schema,
  inputSchema: toInputSchema(schema),
  isReadOnly: false,
  permission(input) {
    return { kind: 'execute', command: input.command };
  },
  execute(input, ctx) {
    if (ctx.signal.aborted) {
      return Promise.resolve({ ok: false, output: 'run_command was aborted before it started.' });
    }
    const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    return new Promise<ToolResult>((resolvePromise) => {
      const useProcessGroup = process.platform !== 'win32';
      const child = spawn('bash', ['-c', input.command], {
        cwd: ctx.cwd,
        detached: useProcessGroup,
      });
      const stdout = new TailBuffer(TAIL_BYTES);
      const stderr = new TailBuffer(TAIL_BYTES);
      let killedReason: 'timeout' | 'aborted' | null = null;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const killTimer = setTimeout(() => {
        requestKill('timeout');
      }, timeout);

      const onAbort = () => {
        requestKill('aborted');
      };

      const settle = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolvePromise(result);
      };

      const signalChild = (signal: NodeJS.Signals) => {
        if (useProcessGroup && child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ESRCH') return;
          }
        }
        child.kill(signal);
      };

      function requestKill(reason: 'timeout' | 'aborted'): void {
        killedReason ??= reason;
        signalChild('SIGTERM');
        if (!forceKillTimer) {
          forceKillTimer = setTimeout(() => signalChild('SIGKILL'), 5000);
          forceKillTimer.unref();
        }
      }

      child.stdout.on('data', (d: Buffer) => {
        stdout.append(d);
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr.append(d);
      });
      child.on('error', (e) => settle({ ok: false, output: `spawn failed: ${e.message}` }));
      child.on('close', (code) => {
        let body = stdout.toString();
        const stderrText = stderr.toString();
        if (stderrText.trim()) body += `\n[stderr]\n${stderrText}`;
        body = truncateTail(
          body,
          TAIL_LINES,
          TAIL_BYTES,
          stdout.wasTruncated || stderr.wasTruncated,
        );
        if (killedReason === 'timeout') body += `\n[killed: timeout ${timeout}ms]`;
        if (killedReason === 'aborted') body += '\n[killed: aborted]';
        settle({
          ok: code === 0 && killedReason === null,
          output: `exit code: ${code ?? 'null'}\n${body}`,
        });
      });

      ctx.signal.addEventListener('abort', onAbort, { once: true });
      if (ctx.signal.aborted) requestKill('aborted');
    });
  },
};

/** Keep the tail (errors usually live at the end); note the truncation at the top. */
function truncateTail(
  s: string,
  maxLines: number,
  maxBytes: number,
  previouslyTruncated = false,
): string {
  const bytes = Buffer.from(s);
  const byteTruncated = bytes.length > maxBytes;
  let out = byteTruncated ? bytes.subarray(bytes.length - maxBytes).toString('utf8') : s;
  const lines = out.split('\n');
  let lineTruncated = false;
  if (lines.length > maxLines) {
    lineTruncated = true;
    out = lines.slice(-maxLines).join('\n');
  }
  if (previouslyTruncated || byteTruncated || lineTruncated) {
    out = `[truncated: showing output tail]\n${out}`;
  }
  return out;
}

/** Bounded byte tail so a noisy child process cannot grow the parent heap without limit. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  wasTruncated = false;

  constructor(private maxBytes: number) {}

  append(chunk: Buffer): void {
    if (chunk.length >= this.maxBytes) {
      this.chunks = [chunk.subarray(chunk.length - this.maxBytes)];
      this.bytes = this.maxBytes;
      this.wasTruncated = true;
      return;
    }

    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes) {
      const first = this.chunks[0];
      if (!first) break;
      const excess = this.bytes - this.maxBytes;
      this.wasTruncated = true;
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.bytes).toString('utf8');
  }
}
