import type { ContextReport } from './types.js';

export class ContextBudgetError extends Error {
  override name = 'ContextBudgetError';

  constructor(
    message: string,
    readonly report: ContextReport,
  ) {
    super(message);
  }
}
