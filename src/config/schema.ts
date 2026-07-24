import { z } from 'zod';

export const ModelProviderSchema = z.enum(['anthropic', 'openai', 'local']);

export const ModelConfigSchema = z
  .object({
    provider: ModelProviderSchema,
    model: z.string().min(1),
    /** Direct API key. Takes precedence over apiKeyEnv. Prefer env vars for real secrets. */
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    baseURL: z.string().url().optional(),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .superRefine((model, ctx) => {
    if (model.provider === 'local' && !model.baseURL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseURL'],
        message: 'baseURL is required when provider is "local"',
      });
    }
  });

export const PermissionDecisionSchema = z.enum(['allow', 'confirm', 'deny']);

export const PermissionRuleSchema = z
  .object({
    id: z.string().min(1),
    decision: PermissionDecisionSchema,
    tools: z.array(z.string().min(1)).min(1).optional(),
    paths: z.array(z.string().min(1)).min(1).optional(),
    commandPrefixes: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((rule) => rule.tools || rule.paths || rule.commandPrefixes, {
    message: 'permission rule must define at least one matcher',
  });

export const PermissionsSchema = z.object({
  default: PermissionDecisionSchema.optional(),
  overrides: z.record(z.string(), PermissionDecisionSchema).optional(),
  rules: z.array(PermissionRuleSchema).optional(),
});

export const AgentContextConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    windowTokens: z.number().int().positive().optional(),
    safetyReserveTokens: z.number().int().nonnegative().optional(),
    minimumOutputTokens: z.number().int().positive().optional(),
    preserveRecentTurns: z.number().int().nonnegative().optional(),
    toolResultTokens: z.number().int().positive().optional(),
    summaryTriggerRatio: z.number().positive().max(1).optional(),
  })
  .superRefine((context, ctx) => {
    if (
      context.windowTokens !== undefined &&
      context.minimumOutputTokens !== undefined &&
      context.minimumOutputTokens + (context.safetyReserveTokens ?? 0) >= context.windowTokens
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minimumOutputTokens'],
        message: 'minimumOutputTokens plus safetyReserveTokens must be smaller than windowTokens',
      });
    }
  });

export const AgentConfigSchema = z.object({
  maxSteps: z.number().int().positive().optional(),
  /** Phase 1 compatibility field; no longer used as a hard message cutoff. */
  contextMessages: z.number().int().positive().optional(),
  context: AgentContextConfigSchema.optional(),
});

export const ConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    model: ModelConfigSchema.optional(),
    agent: AgentConfigSchema.optional(),
    permissions: PermissionsSchema.optional(),
    rules: z.array(z.string()).optional(),
    includeCoAuthoredBy: z.boolean().optional(),
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  })
  .superRefine((config, ctx) => {
    const minimumOutput = config.agent?.context?.minimumOutputTokens;
    const requestedOutput = config.model?.maxTokens;
    if (
      minimumOutput !== undefined &&
      requestedOutput !== undefined &&
      minimumOutput > requestedOutput
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent', 'context', 'minimumOutputTokens'],
        message: 'minimumOutputTokens cannot exceed model.maxTokens',
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentContextConfig = z.infer<typeof AgentContextConfigSchema>;
