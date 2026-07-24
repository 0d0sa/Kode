import { z } from 'zod';
import type { PermissionPath } from '../../permission/types.js';
import type { CodebaseService } from '../../codebase/service.js';
import { resolveToolPath } from '../path.js';
import { toInputSchema, type Tool } from '../types.js';

const symbolKinds = [
  'class',
  'interface',
  'type',
  'enum',
  'function',
  'method',
  'variable',
  'constant',
  'module',
  'namespace',
  'unknown',
] as const;

const listSymbolsSchema = z.object({
  path: z.string().min(1).optional().describe('Optional workspace-relative file or directory'),
  name: z.string().min(1).max(200).optional().describe('Optional case-insensitive name filter'),
  kind: z.enum(symbolKinds).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

const findDefinitionSchema = z.object({
  name: z.string().min(1).max(200).describe('Exact symbol or qualified name'),
  from_path: z
    .string()
    .min(1)
    .optional()
    .describe('Optional workspace-relative source path used to rank candidates'),
  limit: z.number().int().min(1).max(100).optional(),
});

const findReferencesSchema = z.object({
  name: z.string().min(1).max(200).describe('Exact identifier name'),
  path: z.string().min(1).optional().describe('Optional workspace-relative file or directory'),
  include_declaration: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

const moduleDependenciesSchema = z.object({
  path: z.string().min(1).describe('Workspace-relative file or directory'),
  direction: z.enum(['incoming', 'outgoing', 'both']).optional(),
  depth: z.number().int().min(1).max(3).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export function createCodebaseTools(service: CodebaseService): Tool[] {
  const listSymbols: Tool<z.infer<typeof listSymbolsSchema>> = {
    name: 'list_symbols',
    description:
      'List indexed code symbols by file/directory, partial name, and kind. Results include 1-based locations, signatures, coverage, freshness, and a stable pagination cursor.',
    schema: listSymbolsSchema,
    inputSchema: toInputSchema(listSymbolsSchema),
    isReadOnly: true,
    permission: (input, ctx) => readPermission(ctx.cwd, input.path),
    async execute(input, ctx) {
      const result = await service.listSymbols(
        {
          ...(input.path ? { path: input.path } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        ctx.signal,
      );
      return output(result);
    },
  };

  const findDefinition: Tool<z.infer<typeof findDefinitionSchema>> = {
    name: 'find_definition',
    description:
      'Find exact symbol definitions. Returns all plausible candidates ordered by source/import proximity instead of silently choosing an ambiguous definition.',
    schema: findDefinitionSchema,
    inputSchema: toInputSchema(findDefinitionSchema),
    isReadOnly: true,
    permission: (input, ctx) => readPermission(ctx.cwd, input.from_path),
    async execute(input, ctx) {
      const result = await service.findDefinitions(
        {
          name: input.name,
          ...(input.from_path ? { fromPath: input.from_path } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        },
        ctx.signal,
      );
      return output(result);
    },
  };

  const findReferences: Tool<z.infer<typeof findReferencesSchema>> = {
    name: 'find_references',
    description:
      'Find syntax-level references to an exact identifier in the indexed coverage. Use grep/read_file to verify completeness for dynamic calls or unsupported files.',
    schema: findReferencesSchema,
    inputSchema: toInputSchema(findReferencesSchema),
    isReadOnly: true,
    permission: (input, ctx) => readPermission(ctx.cwd, input.path),
    async execute(input, ctx) {
      const result = await service.findReferences(
        {
          name: input.name,
          ...(input.path ? { path: input.path } : {}),
          ...(input.include_declaration !== undefined
            ? { includeDeclaration: input.include_declaration }
            : {}),
          ...(input.limit ? { limit: input.limit } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        ctx.signal,
      );
      return output(result);
    },
  };

  const moduleDependencies: Tool<z.infer<typeof moduleDependenciesSchema>> = {
    name: 'module_dependencies',
    description:
      'Inspect bounded incoming/outgoing static module dependencies for a workspace-relative file or directory, including unresolved specifiers and confidence.',
    schema: moduleDependenciesSchema,
    inputSchema: toInputSchema(moduleDependenciesSchema),
    isReadOnly: true,
    permission: (input, ctx) => readPermission(ctx.cwd, input.path),
    async execute(input, ctx) {
      const result = await service.dependencies(
        {
          path: input.path,
          ...(input.direction ? { direction: input.direction } : {}),
          ...(input.depth ? { depth: input.depth } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        },
        ctx.signal,
      );
      return output(result);
    },
  };

  return [listSymbols, findDefinition, findReferences, moduleDependencies];
}

async function readPermission(cwd: string, inputPath: string | undefined) {
  const resolved = await resolveToolPath(cwd, inputPath ?? '.');
  const path: PermissionPath = {
    canonical: resolved.canonical,
    relative: resolved.relative,
    outsideWorkspace: resolved.outsideWorkspace,
  };
  return { kind: 'read' as const, paths: [path] };
}

function output(value: object) {
  const status = 'status' in value ? (value.status as Record<string, unknown>) : undefined;
  return {
    ok: true,
    output: JSON.stringify(value, null, 2),
    ...(status
      ? {
          meta: {
            generation: status.generation,
            state: status.state,
            coverage: status.coverage,
            staleFiles: status.staleFiles,
          },
        }
      : {}),
  };
}
