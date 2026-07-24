export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface LLMMessage {
  role: Role;
  content: string | ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CompleteOptions {
  model: string;
  /** Anthropic: top-level system param. OpenAI: converted to a leading system message. */
  system?: string;
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface TokenCountRequest {
  model: string;
  system: string;
  tools: ToolSpec[];
  messages: LLMMessage[];
}

export interface TokenCount {
  tokens: number;
  accuracy: 'exact' | 'tokenizer' | 'estimated';
  source: string;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'stop'; reason: 'end_turn' | 'tool_use' | 'max_tokens' };

export interface ModelInfo {
  contextWindowTokens: number;
  supportsToolUse: boolean;
}

export interface LLMProvider {
  complete(messages: LLMMessage[], opts: CompleteOptions): AsyncIterable<StreamEvent>;
  /** Optional provider-native exact input count. Callers must fall back on failure. */
  countTokens?(request: TokenCountRequest, signal?: AbortSignal): Promise<number>;
  modelInfo(model: string): ModelInfo;
}

/** Legacy message-only estimate retained for compatibility with external callers. */
export function estimateTokens(messages: LLMMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

export function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === 'AbortError' || e.constructor.name === 'APIUserAbortError')
  );
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
