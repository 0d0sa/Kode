import { z } from 'zod';
import type { PermissionPath } from '../../permission/types.js';
import { applyFileMutations } from '../mutation.js';
import { assertAuthorizedToolPath, resolveToolPath } from '../path.js';
import { toInputSchema, type Tool } from '../types.js';

const SHA256 = /^[a-f0-9]{64}$/;

const schema = z.object({
  path: z.string().min(1).describe('File path, relative to the working directory or absolute'),
  content: z.string().describe('Complete UTF-8 file content'),
  overwrite: z.boolean().optional().describe('Must be true to overwrite an existing file'),
  create_directories: z
    .boolean()
    .optional()
    .describe('Create missing parent directories, default false'),
  expected_sha256: z
    .string()
    .regex(SHA256)
    .optional()
    .describe('Required when overwriting; copy this from read_file'),
});

export const writeFileTool: Tool<z.infer<typeof schema>> = {
  name: 'write_file',
  description:
    'Create a UTF-8 file or explicitly overwrite it. Existing files require overwrite=true and the sha256 returned by read_file.',
  schema,
  inputSchema: toInputSchema(schema),
  isReadOnly: false,
  async permission(input, ctx) {
    const path = await resolveToolPath(ctx.cwd, input.path, { allowMissing: true });
    return { kind: 'write', paths: [permissionPath(path)] };
  },
  async execute(input, ctx) {
    if (ctx.signal.aborted) return { ok: false, output: 'write_file was aborted.' };
    if (!ctx.undoStore) {
      return { ok: false, output: 'write_file failed: undo storage is unavailable.' };
    }
    const path = await resolveToolPath(ctx.cwd, input.path, { allowMissing: true });
    assertAuthorizedToolPath(ctx.authorizedPaths, path.canonical);
    if (path.exists && !input.overwrite) {
      return {
        ok: false,
        output: `${input.path} already exists; set overwrite=true to replace it.`,
      };
    }
    if (path.exists && !input.expected_sha256) {
      return {
        ok: false,
        output: `Overwriting ${input.path} requires expected_sha256 from read_file.`,
      };
    }
    if (!path.exists && input.expected_sha256) {
      return { ok: false, output: `${input.path} does not exist, so expected_sha256 is invalid.` };
    }

    try {
      const result = await applyFileMutations({
        cwd: path.workspaceRoot,
        runId: ctx.runId ?? 'unknown',
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        mutations: [
          {
            path: path.canonical,
            content: Buffer.from(input.content),
            createDirectories: input.create_directories ?? false,
            ...(input.expected_sha256 ? { expectedSha256: input.expected_sha256 } : {}),
          },
        ],
        signal: ctx.signal,
        undoStore: ctx.undoStore,
      });
      const changed = result.files[0];
      return {
        ok: true,
        output: `${changed?.created ? 'Created' : 'Overwrote'} ${input.path} (${changed?.bytes ?? 0} bytes, sha256 ${changed?.afterSha256 ?? ''}). Undo ID: ${result.undoId}.`,
        meta: { ...changed, undoId: result.undoId },
      };
    } catch (error) {
      return { ok: false, output: `write_file failed: ${(error as Error).message}` };
    }
  },
};

function permissionPath(path: Awaited<ReturnType<typeof resolveToolPath>>): PermissionPath {
  return {
    canonical: path.canonical,
    relative: path.relative,
    outsideWorkspace: path.outsideWorkspace,
  };
}
