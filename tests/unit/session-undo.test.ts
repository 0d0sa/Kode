import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSession } from '../../src/cli/session.js';
import type { LLMProvider } from '../../src/llm/types.js';
import { applyFileMutations, sha256 } from '../../src/tools/mutation.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { MemoryUndoStore } from '../../src/tools/undo/store.js';

vi.mock('../../src/infra/logger.js', async () => {
  const { default: pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return {
    configureLogger: () => undefined,
    logger,
    childLogger: () => logger,
  };
});

const provider: LLMProvider = {
  async *complete() {
    yield { type: 'stop', reason: 'end_turn' };
  },
  countTokens: () => 0,
  modelInfo: () => ({ maxTokens: 1, supportsToolUse: true }),
};

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'kode-session-undo-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workdir, { recursive: true, force: true });
});

describe('TerminalSession undo', () => {
  it('restores the latest mutation group through the session command boundary', async () => {
    const store = new MemoryUndoStore();
    const path = join(workdir, 'a.txt');
    writeFileSync(path, 'old');
    await applyFileMutations({
      cwd: workdir,
      runId: 'run-1',
      mutations: [{ path, content: Buffer.from('new'), expectedSha256: sha256('old') }],
      signal: new AbortController().signal,
      undoStore: store,
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const session = new TerminalSession({
      provider,
      registry: new ToolRegistry(),
      model: 'mock',
      config: { version: 1 },
      cwd: workdir,
      autoApprove: true,
      interactive: false,
      undoStore: store,
    });

    expect(await session.undoLast()).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('old');
  });
});
