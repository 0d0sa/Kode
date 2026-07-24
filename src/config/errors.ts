export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly files: string[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}
