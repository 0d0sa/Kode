export class CodebaseIndexError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'cache_unavailable'
      | 'cursor_stale'
      | 'index_disabled'
      | 'invalid_path'
      | 'parser_unavailable',
  ) {
    super(message);
    this.name = 'CodebaseIndexError';
  }
}
