import type { Config } from './schema.js';

/** Return a display-safe copy of config without exposing an inline API key. */
export function redactConfig(config: Config): Config {
  if (!config.model?.apiKey) return config;
  return {
    ...config,
    model: {
      ...config.model,
      apiKey: '[REDACTED]',
    },
  };
}
