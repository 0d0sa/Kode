import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalSession } from '../../src/cli/session.js';
import type {
  CompleteOptions,
  LLMMessage,
  LLMProvider,
  ModelInfo,
  StreamEvent,
  TokenCountRequest,
} from '../../src/llm/types.js';
import { ToolRegistry } from '../../src/tools/registry.js';

vi.mock('../../src/infra/logger.js', async () => {
  const { default: pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return {
    configureLogger: () => undefined,
    logger,
    childLogger: () => logger,
  };
});

class DebugProvider implements LLMProvider {
  async *complete(_messages: LLMMessage[], _opts: CompleteOptions): AsyncIterable<StreamEvent> {
    yield { type: 'text', delta: 'ok' };
    yield { type: 'stop', reason: 'end_turn' };
  }

  async countTokens(_request: TokenCountRequest): Promise<number> {
    return 42;
  }

  modelInfo(): ModelInfo {
    return { contextWindowTokens: 1000, supportsToolUse: true };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TerminalSession context debug output', () => {
  it('writes numeric budget data to stderr without leaking prompt text', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const session = new TerminalSession({
      provider: new DebugProvider(),
      registry: new ToolRegistry(),
      model: 'mock',
      config: {
        version: 1,
        model: { provider: 'openai', model: 'mock', maxTokens: 100 },
        agent: {
          context: {
            windowTokens: 1000,
            safetyReserveTokens: 0,
            minimumOutputTokens: 50,
          },
        },
      },
      cwd: process.cwd(),
      interactive: false,
      debug: true,
    });

    await expect(session.runTurn('TOP_SECRET_PROMPT')).resolves.toMatchObject({
      ok: true,
      reason: 'end_turn',
    });
    expect(stdout.join('')).toContain('ok');
    expect(stdout.join('')).not.toContain('[context]');
    expect(stderr.join('')).toContain('[context] window=1000');
    expect(stderr.join('')).not.toContain('TOP_SECRET_PROMPT');
  });
});
