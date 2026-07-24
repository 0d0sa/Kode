import OpenAI from 'openai';
import { childLogger } from '../infra/logger.js';
import { toOpenAIMessages, toOpenAITools } from './convert-openai.js';
import type { CompleteOptions, LLMMessage, LLMProvider, ModelInfo, StreamEvent } from './types.js';
import { abortableSleep, estimateTokens } from './types.js';

const log = childLogger('llm');

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 529]);
const MAX_RETRIES = 3;

export interface OpenAIProviderOptions {
  apiKey: string;
  baseURL?: string;
}

/** Works with OpenAI and any OpenAI-compatible chat.completions endpoint (via baseURL). */
export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(opts: OpenAIProviderOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      maxRetries: 0,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async *complete(messages: LLMMessage[], opts: CompleteOptions): AsyncIterable<StreamEvent> {
    const req: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: opts.model,
      messages: toOpenAIMessages(messages, opts.system),
      stream: true,
      ...(opts.tools?.length ? { tools: toOpenAITools(opts.tools) } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };
    log.debug({ provider: 'openai', model: opts.model, msgs: req.messages.length }, 'llm request');

    const stream = await this.createWithRetry(req, opts.signal, 0);

    // Buffer streamed tool_calls per index; emit once complete (Phase1 §6.1).
    const pending = new Map<number, { id: string; name: string; json: string }>();
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta.content) yield { type: 'text', delta: delta.content };
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const buf = pending.get(tc.index) ?? { id: '', name: '', json: '' };
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.name += tc.function.name;
          if (tc.function?.arguments) buf.json += tc.function.arguments;
          pending.set(tc.index, buf);
        }
      }
      if (choice.finish_reason) {
        yield { type: 'stop', reason: mapFinishReason(choice.finish_reason) };
      }
    }
    for (const [, buf] of [...pending.entries()].sort(([a], [b]) => a - b)) {
      yield { type: 'tool_use', id: buf.id, name: buf.name, input: safeParseJson(buf.json) };
    }
  }

  private async createWithRetry(
    req: OpenAI.ChatCompletionCreateParamsStreaming,
    signal: AbortSignal | undefined,
    attempt: number,
  ): Promise<AsyncIterable<OpenAI.ChatCompletionChunk>> {
    try {
      return await this.client.chat.completions.create(req, { signal });
    } catch (e) {
      if (e instanceof OpenAI.APIError && RETRYABLE_STATUS.has(e.status) && attempt < MAX_RETRIES) {
        const waitMs = 2 ** attempt * 1000 + Math.random() * 500;
        log.warn(
          { status: e.status, attempt, waitMs },
          'llm request retryable failure, backing off',
        );
        await abortableSleep(waitMs, signal);
        return this.createWithRetry(req, signal, attempt + 1);
      }
      throw e;
    }
  }

  countTokens(messages: LLMMessage[]): number {
    return estimateTokens(messages);
  }

  modelInfo(_model: string): ModelInfo {
    return { maxTokens: 128_000, supportsToolUse: true };
  }
}

function mapFinishReason(reason: string): 'end_turn' | 'tool_use' | 'max_tokens' {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

/** On parse failure return {} and let tool-side zod validation report back to the model. */
function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
}
