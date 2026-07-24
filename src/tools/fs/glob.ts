import { z } from 'zod';
import type { PermissionPath } from '../../permission/types.js';
import { assertAuthorizedToolPath, resolveToolPath } from '../path.js';
import type { SearchAdapter } from '../search/adapter.js';
import { HybridSearchAdapter } from '../search/adapter.js';
import { toInputSchema, type Tool } from '../types.js';

const DEFAULT_LIMIT = 2000;
const MAX_OUTPUT_BYTES = 200 * 1024;
const schema = z.object({
  pattern: z.string().min(1).describe('Glob pattern relative to path/cwd'),
  path: z.string().min(1).optional().describe('Search root, default working directory'),
  ignore: z.array(z.string().min(1)).optional(),
  hidden: z.boolean().optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
});

export function createGlobTool(
  adapter: SearchAdapter = new HybridSearchAdapter(),
): Tool<z.infer<typeof schema>> {
  return {
    name: 'glob',
    description:
      'Find files by glob pattern. Results are stable, workspace-relative, ignore-aware, and bounded.',
    schema,
    inputSchema: toInputSchema(schema),
    isReadOnly: true,
    async permission(input, ctx) {
      const root = await resolveToolPath(ctx.cwd, input.path ?? '.');
      return { kind: 'read', paths: [permissionPath(root, true)] };
    },
    async execute(input, ctx) {
      const root = await resolveToolPath(ctx.cwd, input.path ?? '.');
      assertAuthorizedToolPath(ctx.authorizedPaths, root.canonical);
      const result = await adapter.glob({
        root: root.canonical,
        pattern: input.pattern,
        hidden: input.hidden ?? false,
        limit: input.limit ?? DEFAULT_LIMIT,
        signal: ctx.signal,
        ...(input.ignore ? { ignore: input.ignore } : {}),
      });
      const bounded = boundLines(result.files, MAX_OUTPUT_BYTES);
      const output = bounded.lines.length ? bounded.lines.join('\n') : '(no files found)';
      const truncated = result.truncated || bounded.truncated;
      return {
        ok: true,
        output: `${output}${truncated ? '\n[truncated]' : ''}`,
        meta: {
          backend: result.backend,
          count: bounded.lines.length,
          truncated,
          root: root.canonical,
        },
      };
    },
  };
}

function permissionPath(
  path: Awaited<ReturnType<typeof resolveToolPath>>,
  recursive: boolean,
): PermissionPath {
  return {
    canonical: path.canonical,
    relative: path.relative,
    outsideWorkspace: path.outsideWorkspace,
    recursive,
  };
}

export const globTool = createGlobTool();

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
