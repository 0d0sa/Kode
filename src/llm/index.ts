import type { Config, ModelConfig } from '../config/schema.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import type { LLMProvider } from './types.js';

const DEFAULT_KEY_ENV: Record<ModelConfig['provider'], string | undefined> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  local: undefined,
};

export class ProviderConfigError extends Error {
  override name = 'ProviderConfigError';
}

export interface ResolvedProvider {
  provider: LLMProvider;
  model: string;
}

/**
 * Build a provider from config. Both Anthropic-compatible and OpenAI-compatible
 * endpoints are supported; baseURL/model/apiKey all come from kode.jsonc (+ env).
 * API key resolution order: model.apiKey → env[model.apiKeyEnv] → provider default
 * env var → ('local' only) placeholder.
 */
export function createProvider(config: Config): ResolvedProvider {
  const model = config.model;
  if (!model) {
    throw new ProviderConfigError(
      'No model configured. Add a "model" section to kode.jsonc (see docs/examples/kode.jsonc).',
    );
  }
  if (model.provider === 'local' && !model.baseURL) {
    throw new ProviderConfigError(
      'model.baseURL is required when model.provider is "local"; refusing to use the public OpenAI endpoint.',
    );
  }
  const apiKey = resolveApiKey(model);
  const baseURLOpt = model.baseURL ? { baseURL: model.baseURL } : {};

  switch (model.provider) {
    case 'anthropic':
      return { provider: new AnthropicProvider({ apiKey, ...baseURLOpt }), model: model.model };
    case 'openai':
    case 'local':
      return { provider: new OpenAIProvider({ apiKey, ...baseURLOpt }), model: model.model };
  }
}

function resolveApiKey(model: ModelConfig): string {
  if (model.apiKey) return model.apiKey;
  if (model.apiKeyEnv) {
    const v = process.env[model.apiKeyEnv];
    if (v) return v;
    throw new ProviderConfigError(
      `Missing API key: env var ${model.apiKeyEnv} (referenced by model.apiKeyEnv) is not set.`,
    );
  }
  const defaultEnv = DEFAULT_KEY_ENV[model.provider];
  if (defaultEnv) {
    const v = process.env[defaultEnv];
    if (v) return v;
    throw new ProviderConfigError(
      `Missing API key: set ${defaultEnv} in your environment/.env, or set model.apiKey / model.apiKeyEnv in kode.jsonc.`,
    );
  }
  // 'local' endpoints frequently require no auth; the SDK still needs a non-empty key.
  return 'kode-local';
}

export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider } from './openai.js';
export type * from './types.js';
