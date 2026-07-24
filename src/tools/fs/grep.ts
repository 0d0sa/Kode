import { z } from 'zod';
import type { PermissionPath } from '../../permission/types.js';
import { assertAuthorizedToolPath, resolveToolPath } from '../path.js';
import type { SearchAdapter } from '../search/adapter.js';
import { HybridSearchAdapter } from '../search/adapter.js';
import { toInputSchema, type Tool } from '../types.js';

const DEFAULT_MAX_MATCHES = 500;
const MAX_OUTPUT_BYTES = 300 * 1024;
const schema = z.object({
  pattern: z.string().min(1).describe('Regular expression, or literal text with literal=true'),
  path: z.string().min(1).optional().describe('Search root, default working directory'),
  glob: z.string().min(1).optional().describe('Optional file glob filter'),
  literal: z.boolean().optional(),
  case_sensitive: z.boolean().optional(),
  context: z.number().int().min(0).max(10).optional(),
  max_matches: z.number().int().min(1).max(5000).optional(),
});

export function createGrepTool(
  adapter: SearchAdapter = new HybridSearchAdapter(),
): Tool<z.infer<typeof schema>> {
  return {
    name: 'grep',
    description:
      'Search text files with a regex or literal string. Returns path:line:column matches with bounded output.',
    schema,
    inputSchema: toInputSchema(schema),
    isReadOnly: true,
    async permission(input, ctx) {
      const root = await resolveToolPath(ctx.cwd, input.path ?? '.');
      return { kind: 'read', paths: [permissionPath(root)] };
    },
    async execute(input, ctx) {
      const root = await resolveToolPath(ctx.cwd, input.path ?? '.');
      assertAuthorizedToolPath(ctx.authorizedPaths, root.canonical);
      const result = await adapter.grep({
        root: root.canonical,
        pattern: input.pattern,
        literal: input.literal ?? false,
        caseSensitive: input.case_sensitive ?? true,
        context: input.context ?? 0,
        maxMatches: input.max_matches ?? DEFAULT_MAX_MATCHES,
        signal: ctx.signal,
        ...(input.glob ? { glob: input.glob } : {}),
      });
      const formatted = result.hits.map((hit) =>
        hit.kind === 'match'
          ? `${hit.path}:${hit.line}:${hit.column}: ${hit.text}`
          : `${hit.path}-${hit.line}- ${hit.text}`,
      );
      const bounded = boundLines(formatted, MAX_OUTPUT_BYTES);
      const truncated = result.truncated || bounded.truncated;
      return {
        ok: true,
        output: `${bounded.lines.join('\n') || '(no matches)'}${truncated ? '\n[truncated]' : ''}`,
        meta: {
          backend: result.backend,
          matches: result.matches,
          truncated,
          root: root.canonical,
        },
      };
    },
  };
}

function permissionPath(path: Awaited<ReturnType<typeof resolveToolPath>>): PermissionPath {
  return {
    canonical: path.canonical,
    relative: path.relative,
    outsideWorkspace: path.outsideWorkspace,
    recursive: true,
  };
}

export const grepTool = createGrepTool();

function boundLines(lines: string[], maxBytes: number): { lines: string[]; truncated: boolean } {
  const result: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const next = Buffer.byteLength(line) + (result.length ? 1 : 0);
    if (bytes + next > maxBytes) return { lines: result, truncated: true };
    result.push(line);
    bytes += next;
  }
  return { lines: result, truncated: false };
}
