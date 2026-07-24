import Anthropic from '@anthropic-ai/sdk';
import { childLogger } from '../infra/logger.js';
import { toAnthropicMessages } from './convert-anthropic.js';
import type {
  CompleteOptions,
  LLMMessage,
  LLMProvider,
  ModelInfo,
  StreamEvent,
  TokenCountRequest,
} from './types.js';
import { abortableSleep } from './types.js';

const log = childLogger('llm');

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 529]);
const MAX_RETRIES = 3;
const DEFAULT_MAX_TOKENS = 8192;

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string;
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: 0,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async *complete(messages: LLMMessage[], opts: CompleteOptions): AsyncIterable<StreamEvent> {
    const converted = toAnthropicMessages(messages);
    const system = opts.system ?? converted.system;
    const req: Anthropic.MessageCreateParamsStreaming = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: converted.messages,
      stream: true,
      ...(system ? { system } : {}),
      ...(opts.tools?.length ? { tools: opts.tools as Anthropic.Tool[] } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };
    log.debug(
      { provider: 'anthropic', model: opts.model, msgs: converted.messages.length },
      'llm request',
    );

    const stream = await this.createWithRetry(req, opts.signal, 0);

    // Buffer tool_use blocks: partial JSON accumulates until content_block_stop (Phase1 §6.1).
    let pending: { id: string; name: string; json: string } | null = null;
    for await (const ev of stream) {
      switch (ev.type) {
        case 'content_block_start':
          if (ev.content_block.type === 'tool_use') {
            pending = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
          }
          break;
        case 'content_block_delta':
          if (ev.delta.type === 'text_delta') {
            yield { type: 'text', delta: ev.delta.text };
          } else if (ev.delta.type === 'input_json_delta' && pending) {
            pending.json += ev.delta.partial_json;
          }
          break;
        case 'content_block_stop':
          if (pending) {
            yield {
              type: 'tool_use',
              id: pending.id,
              name: pending.name,
              input: safeParseJson(pending.json),
            };
            pending = null;
          }
          break;
        case 'message_delta':
          if (ev.delta.stop_reason) {
            yield { type: 'stop', reason: mapStopReason(ev.delta.stop_reason) };
          }
          break;
      }
    }
  }

  private async createWithRetry(
    req: Anthropic.MessageCreateParamsStreaming,
    signal: AbortSignal | undefined,
    attempt: number,
  ): Promise<AsyncIterable<Anthropic.MessageStreamEvent>> {
    try {
      return await this.client.messages.create(req, { signal });
    } catch (e) {
      if (
        e instanceof Anthropic.APIError &&
        RETRYABLE_STATUS.has(e.status) &&
        attempt < MAX_RETRIES
      ) {
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

  async countTokens(request: TokenCountRequest, signal?: AbortSignal): Promise<number> {
    const converted = toAnthropicMessages(request.messages);
    const system = request.system || converted.system;
    const result = await this.client.messages.countTokens(
      {
        model: request.model,
        messages: converted.messages,
        ...(system ? { system } : {}),
        ...(request.tools.length
          ? { tools: request.tools as Anthropic.MessageCountTokensTool[] }
          : {}),
      },
      { signal },
    );
    return result.input_tokens;
  }

  modelInfo(_model: string): ModelInfo {
    return { contextWindowTokens: 200_000, supportsToolUse: true };
  }
}

function mapStopReason(reason: string): 'end_turn' | 'tool_use' | 'max_tokens' {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
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
