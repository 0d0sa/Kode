import { z } from 'zod';

export const ModelProviderSchema = z.enum(['anthropic', 'openai', 'local']);

export const ModelConfigSchema = z.object({
  provider: ModelProviderSchema,
  model: z.string().min(1),
  apiKeyEnv: z.string().optional(),
  baseURL: z.string().url().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const PermissionDecisionSchema = z.enum(['allow', 'confirm', 'deny']);

export const PermissionsSchema = z.object({
  default: PermissionDecisionSchema.optional(),
  overrides: z.record(z.string(), PermissionDecisionSchema).optional(),
});

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  model: ModelConfigSchema.optional(),
  permissions: PermissionsSchema.optional(),
  rules: z.array(z.string()).optional(),
  includeCoAuthoredBy: z.boolean().optional(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;
