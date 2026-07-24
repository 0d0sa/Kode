import { describe, expect, it } from 'vitest';
import { redactConfig } from '../../src/config/redact.js';
import type { Config } from '../../src/config/schema.js';

describe('redactConfig', () => {
  it('redacts inline API keys without mutating the resolved config', () => {
    const config: Config = {
      version: 1,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'super-secret',
      },
    };
    const redacted = redactConfig(config);
    expect(redacted.model?.apiKey).toBe('[REDACTED]');
    expect(config.model?.apiKey).toBe('super-secret');
    expect(JSON.stringify(redacted)).not.toContain('super-secret');
  });
});
