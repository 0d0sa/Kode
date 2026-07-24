import { describe, expect, it } from 'vitest';
import { resolveLogLevel } from '../../src/infra/log-level.js';

describe('resolveLogLevel', () => {
  it('defaults to info', () => {
    expect(resolveLogLevel(undefined, undefined)).toBe('info');
  });

  it('uses the config level when no environment override is set', () => {
    expect(resolveLogLevel('debug', undefined)).toBe('debug');
  });

  it('gives the environment override precedence over config', () => {
    expect(resolveLogLevel('silent', 'trace')).toBe('trace');
  });
});
