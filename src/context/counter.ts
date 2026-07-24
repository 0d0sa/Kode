import { createHash } from 'node:crypto';
import type { LLMProvider, TokenCount, TokenCountRequest, ToolSpec } from '../llm/types.js';
import { isAbortError } from '../llm/types.js';

export interface TokenCounter {
  count(request: TokenCountRequest, signal?: AbortSignal): Promise<TokenCount>;
}

export interface LocalTokenBreakdown {
  systemTokens: number;
  toolSchemaTokens: number;
  historyTokens: number;
  totalTokens: number;
}

export interface RequestTokenCounterOptions {
  localCount?: (request: TokenCountRequest) => number;
  estimate?: (request: TokenCountRequest) => number;
}

/**
 * Provider-native exact counting is preferred. A deterministic local tokenizer
 * covers providers without a counting endpoint; the byte estimate is a final
 * safety fallback and never blocks a model request by itself.
 */
export class RequestTokenCounter implements TokenCounter {
  private cache = new Map<string, TokenCount>();
  private providerExactUnavailable = false;

  constructor(
    private readonly provider: LLMProvider,
    private readonly options: RequestTokenCounterOptions = {},
  ) {}

  async count(request: TokenCountRequest, signal?: AbortSignal): Promise<TokenCount> {
    throwIfAborted(signal);
    const key = requestDigest(request);
    const cached = this.cache.get(key);
    if (cached) return cached;

    if (!this.providerExactUnavailable && this.provider.countTokens) {
      try {
        const tokens = await this.provider.countTokens(request, signal);
        if (Number.isFinite(tokens) && tokens >= 0) {
          const result: TokenCount = {
            tokens: Math.ceil(tokens),
            accuracy: 'exact',
            source: 'provider',
          };
          this.remember(key, result);
          return result;
        }
        this.providerExactUnavailable = true;
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        this.providerExactUnavailable = true;
      }
    }

    try {
      const result: TokenCount = {
        tokens: this.options.localCount?.(request) ?? countLocalRequestTokens(request).totalTokens,
        accuracy: 'tokenizer',
        source: 'builtin',
      };
      this.remember(key, result);
      return result;
    } catch {
      const result: TokenCount = {
        tokens: this.options.estimate?.(request) ?? estimateRequestTokens(request),
        accuracy: 'estimated',
        source: 'utf8-bytes',
      };
      this.remember(key, result);
      return result;
    }
  }

  clear(): void {
    this.cache.clear();
    this.providerExactUnavailable = false;
  }

  private remember(key: string, value: TokenCount): void {
    if (this.cache.size >= 256) {
      const first = this.cache.keys().next().value as string | undefined;
      if (first) this.cache.delete(first);
    }
    this.cache.set(key, value);
  }
}

export function countLocalRequestTokens(request: TokenCountRequest): LocalTokenBreakdown {
  const systemTokens = tokenizeText(request.system);
  const toolSchemaTokens = tokenizeTools(request.tools);
  let historyTokens = 3;
  for (const message of request.messages) {
    historyTokens += 4 + tokenizeText(message.role);
    historyTokens += tokenizeText(
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    );
  }
  return {
    systemTokens,
    toolSchemaTokens,
    historyTokens,
    totalTokens: systemTokens + toolSchemaTokens + historyTokens,
  };
}

/**
 * A small model-agnostic tokenizer: ASCII word runs are split conservatively,
 * while CJK/non-ASCII code points and punctuation count individually.
 */
export function tokenizeText(text: string): number {
  let tokens = 0;
  let asciiRun = 0;
  const flushAscii = () => {
    if (asciiRun > 0) {
      tokens += Math.ceil(asciiRun / 3);
      asciiRun = 0;
    }
  };

  for (const char of text) {
    if (/[A-Za-z0-9_]/.test(char)) {
      asciiRun++;
      continue;
    }
    flushAscii();
    if (!/\s/u.test(char)) tokens++;
  }
  flushAscii();
  return tokens;
}

export function estimateRequestTokens(request: TokenCountRequest): number {
  const serialized = JSON.stringify({
    system: request.system,
    tools: request.tools,
    messages: request.messages,
  });
  return Math.ceil(Buffer.byteLength(serialized, 'utf8') / 3) + request.messages.length * 4 + 8;
}

export function scaleBreakdown(
  request: TokenCountRequest,
  total: number,
): Omit<LocalTokenBreakdown, 'totalTokens'> {
  const local = countLocalRequestTokens(request);
  if (local.totalTokens <= 0 || local.totalTokens === total) {
    return {
      systemTokens: local.systemTokens,
      toolSchemaTokens: local.toolSchemaTokens,
      historyTokens: local.historyTokens,
    };
  }
  const systemTokens = Math.round((local.systemTokens / local.totalTokens) * total);
  const toolSchemaTokens = Math.round((local.toolSchemaTokens / local.totalTokens) * total);
  return {
    systemTokens,
    toolSchemaTokens,
    historyTokens: Math.max(0, total - systemTokens - toolSchemaTokens),
  };
}

function tokenizeTools(tools: ToolSpec[]): number {
  if (tools.length === 0) return 0;
  return 4 + tokenizeText(JSON.stringify(tools)) + tools.length * 3;
}

function requestDigest(request: TokenCountRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        model: request.model,
        system: request.system,
        tools: request.tools,
        messages: request.messages,
      }),
    )
    .digest('hex');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}
