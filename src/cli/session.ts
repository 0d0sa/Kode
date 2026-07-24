import { randomUUID } from 'node:crypto';
import { agentLoop } from '../agent/loop.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { DEFAULT_MAX_STEPS } from '../agent/types.js';
import type { AgentDoneReason } from '../agent/types.js';
import { ContextManager, DEFAULT_MAX_OUTPUT_TOKENS } from '../context/manager.js';
import type { ContextReport } from '../context/types.js';
import { findConfigFiles } from '../config/find.js';
import { loadConfig } from '../config/loader.js';
import type { Config } from '../config/schema.js';
import { configureLogger, logger } from '../infra/logger.js';
import { createProvider } from '../llm/index.js';
import type { LLMMessage, LLMProvider } from '../llm/types.js';
import { createDefaultRegistry } from '../tools/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ApprovalRequest, ApprovalResult, ToolContext } from '../tools/types.js';
import { undoLatest } from '../tools/mutation.js';
import { FileUndoStore } from '../tools/undo/store.js';
import type { UndoGroup, UndoStore } from '../tools/undo/types.js';

export interface SessionDeps {
  provider: LLMProvider;
  registry: ToolRegistry;
  model: string;
  config: Config;
  cwd: string;
  /** --yes: approve everything without asking. */
  autoApprove?: boolean;
  /** Whether an interactive prompt is available (TTY). */
  interactive: boolean;
  /** Required when interactive && !autoApprove: asks the user a question, returns the raw answer. */
  ask?: (question: string, signal?: AbortSignal) => Promise<string>;
  undoStore?: UndoStore;
  debug?: boolean;
}

export interface SessionOptions {
  autoApprove?: boolean;
  interactive: boolean;
  ask?: (question: string, signal?: AbortSignal) => Promise<string>;
  debug?: boolean;
}

export interface TurnResult {
  ok: boolean;
  reason: AgentDoneReason | 'error';
}

/** Load config + build provider/registry/session in one place (REPL and `run` share this). */
export function createSession(cwd: string, opts: SessionOptions): TerminalSession {
  const { config } = loadConfig(findConfigFiles(cwd));
  configureLogger(config.logLevel);
  const { provider, model } = createProvider(config);
  return new TerminalSession({
    provider,
    registry: createDefaultRegistry(config.permissions ?? {}),
    model,
    config,
    cwd,
    undoStore: new FileUndoStore(),
    ...(opts.autoApprove !== undefined ? { autoApprove: opts.autoApprove } : {}),
    interactive: opts.interactive,
    ...(opts.ask ? { ask: opts.ask } : {}),
    ...(opts.debug !== undefined ? { debug: opts.debug } : {}),
  });
}

export class TerminalSession {
  private history: LLMMessage[] = [];
  private sessionApproved = new Set<string>();
  private currentAbort: AbortController | null = null;
  private system: string;
  private readonly contextManager: ContextManager;
  private readonly runId = randomUUID();

  constructor(private deps: SessionDeps) {
    this.system = buildSystemPrompt({
      cwd: deps.cwd,
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
      ...(deps.config.rules ? { rules: deps.config.rules } : {}),
      tools: deps.registry.specs(),
    });
    this.contextManager = new ContextManager({
      provider: deps.provider,
      ...(deps.config.agent?.context ? { context: deps.config.agent.context } : {}),
      ...(deps.config.agent?.contextMessages !== undefined
        ? { legacyContextMessages: deps.config.agent.contextMessages }
        : {}),
    });
  }

  model(): string {
    return this.deps.model;
  }

  /** Abort the running turn; returns false when idle (caller may exit). */
  interrupt(): boolean {
    if (this.currentAbort) {
      this.currentAbort.abort();
      return true;
    }
    return false;
  }

  clearHistory(): void {
    this.history = [];
    this.contextManager.reset();
  }

  historyLength(): number {
    return this.history.length;
  }

  /** Restore the latest successful write group after an explicit user confirmation. */
  async undoLast(): Promise<boolean> {
    const store = this.deps.undoStore;
    if (!store) {
      process.stdout.write('Undo storage is unavailable.\n');
      return false;
    }
    let latest: UndoGroup | null;
    try {
      latest = await store.latest(this.deps.cwd);
    } catch (error) {
      process.stdout.write(`Cannot inspect undo storage: ${(error as Error).message}\n`);
      return false;
    }
    if (!latest) {
      process.stdout.write('Nothing to undo.\n');
      return false;
    }
    if (!this.deps.autoApprove) {
      if (!this.deps.interactive || !this.deps.ask) {
        process.stdout.write('Undo requires an interactive confirmation.\n');
        return false;
      }
      const files = latest.snapshots.map((snapshot) => snapshot.path).join(', ');
      const answer = (
        await this.deps.ask(
          `Restore ${latest.snapshots.length} file(s) from ${latest.id}: ${files}? [y/N] `,
        )
      )
        .trim()
        .toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        process.stdout.write('Undo cancelled.\n');
        return false;
      }
    }

    const ac = new AbortController();
    this.currentAbort = ac;
    try {
      const restored = await undoLatest(this.deps.cwd, store, ac.signal);
      if (!restored) {
        process.stdout.write('Nothing to undo.\n');
        return false;
      }
      process.stdout.write(`Restored ${restored.snapshots.length} file(s) from ${restored.id}.\n`);
      return true;
    } catch (error) {
      process.stdout.write(`Undo failed: ${(error as Error).message}\n`);
      return false;
    } finally {
      this.currentAbort = null;
    }
  }

  private toolContext(signal: AbortSignal): ToolContext {
    return {
      cwd: this.deps.cwd,
      signal,
      approve: (req) => this.approve(req, signal),
      isSessionApproved: (n) => this.sessionApproved.has(n),
      approveSession: (n) => this.sessionApproved.add(n),
      logger,
      runId: this.runId,
      ...(this.deps.undoStore ? { undoStore: this.deps.undoStore } : {}),
    };
  }

  private async approve(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResult> {
    if (signal.aborted) return { decision: 'deny' };
    if (this.deps.autoApprove) return { decision: 'allow', scope: 'once' };
    if (!this.deps.interactive || !this.deps.ask) return { decision: 'deny' };
    const summary = req.summary ?? summarizeInput(req.tool, req.input);
    const reason = req.reason ? ` (${req.reason})` : '';
    const answer = (
      await this.deps.ask(`Allow ${req.tool} ${summary}${reason}? [y]es/[a]lways/[n]o `, signal)
    )
      .trim()
      .toLowerCase();
    if (signal.aborted) return { decision: 'deny' };
    if (answer === 'a' || answer === 'always') return { decision: 'allow', scope: 'session' };
    if (answer === '' || answer === 'y' || answer === 'yes') {
      return { decision: 'allow', scope: 'once' };
    }
    return { decision: 'deny' };
  }

  /** Run one user turn through the agent loop, streaming events to the terminal. */
  async runTurn(input: string): Promise<TurnResult> {
    this.history.push({ role: 'user', content: input });
    const ac = new AbortController();
    this.currentAbort = ac;
    let reason: AgentDoneReason = 'end_turn';
    try {
      for await (const ev of agentLoop({
        provider: this.deps.provider,
        registry: this.deps.registry,
        model: this.deps.model,
        system: this.system,
        messages: this.history,
        maxSteps: this.deps.config.agent?.maxSteps ?? DEFAULT_MAX_STEPS,
        contextManager: this.contextManager,
        ctx: this.toolContext(ac.signal),
        maxTokens: this.deps.config.model?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        ...(this.deps.config.model?.temperature !== undefined
          ? { temperature: this.deps.config.model.temperature }
          : {}),
        signal: ac.signal,
      })) {
        switch (ev.type) {
          case 'text':
            process.stdout.write(ev.delta);
            break;
          case 'tool_call':
            process.stdout.write(`\n→ ${ev.name} ${summarizeInput(ev.name, ev.input)}\n`);
            break;
          case 'tool_result':
            process.stdout.write(
              ev.result.ok ? '  [ok]\n' : `  [error] ${firstLine(ev.result.output)}\n`,
            );
            break;
          case 'context':
            if (this.deps.debug) renderContextReport(ev.report);
            logger.debug({ context: ev.report }, 'context resolved');
            break;
          case 'done':
            reason = ev.reason;
            if (ev.reason === 'aborted') process.stdout.write('\n[aborted]\n');
            else if (ev.reason === 'max_steps')
              process.stdout.write('\n[stopped: max steps reached]\n');
            else if (ev.reason === 'max_tokens') process.stdout.write('\n[stopped: max tokens]\n');
            break;
        }
      }
      return { ok: reason !== 'aborted', reason };
    } catch (e) {
      logger.error({ err: e }, 'agent turn failed');
      process.stdout.write(`\n[error] ${(e as Error).message}\n`);
      return { ok: false, reason: 'error' };
    } finally {
      this.currentAbort = null;
      process.stdout.write('\n');
    }
  }
}

function renderContextReport(report: ContextReport): void {
  const { budget, usage } = report;
  process.stderr.write(
    `[context] window=${budget.contextWindowTokens} input_limit=${budget.inputLimitTokens} output=${budget.maxOutputTokens} safety=${budget.safetyReserveTokens}\n`,
  );
  process.stderr.write(
    `[context] before=${usage.historyTokensBefore} after=${usage.historyTokensAfter} total=${usage.totalInputTokens} accuracy=${usage.countAccuracy}:${usage.countSource}\n`,
  );
  if (report.actions.length > 0) {
    const actions = report.actions
      .map((action) => (action.detail ? `${action.kind}(${action.detail})` : action.kind))
      .join(',');
    process.stderr.write(
      `[context] actions=${actions} checkpoint_reused=${report.checkpointReused ? 1 : 0} summary_calls=${report.summaryCalls} ms=${report.durationMs}\n`,
    );
  }
}

function summarizeInput(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const s =
    name === 'run_command' ? String(o.command ?? '') : String(o.path ?? JSON.stringify(input));
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
}

function firstLine(s: string): string {
  return s.split('\n', 1)[0] ?? '';
}
