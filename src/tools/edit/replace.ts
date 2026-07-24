import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { PermissionPath } from '../../permission/types.js';
import { applyFileMutations, sha256 } from '../mutation.js';
import { assertAuthorizedToolPath, resolveToolPath } from '../path.js';
import { toInputSchema, type Tool } from '../types.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

const schema = z.object({
  path: z.string().min(1).describe('File path, relative to the working directory or absolute'),
  old_string: z.string().min(1).describe('Exact text to find; must match exactly one location'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace all occurrences instead of requiring a unique match'),
  expected_sha256: z
    .string()
    .regex(SHA256)
    .describe('Current file hash returned by read_file; protects against concurrent edits'),
});

export const replaceInFileTool: Tool<z.infer<typeof schema>> = {
  name: 'replace_in_file',
  description:
    'Replace exact text in a file. Requires the sha256 from read_file and fails on concurrent changes or multiple matches unless replace_all=true.',
  schema,
  inputSchema: toInputSchema(schema),
  isReadOnly: false,
  async permission(input, ctx) {
    const path = await resolveToolPath(ctx.cwd, input.path);
    return { kind: 'write', paths: [permissionPath(path)] };
  },
  async execute(input, ctx) {
    if (ctx.signal.aborted) return { ok: false, output: 'replace_in_file was aborted.' };
    if (!ctx.undoStore) {
      return { ok: false, output: 'replace_in_file failed: undo storage is unavailable.' };
    }
    const path = await resolveToolPath(ctx.cwd, input.path).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      },
    );
    if (!path) return { ok: false, output: `File not found: ${input.path}` };
    assertAuthorizedToolPath(ctx.authorizedPaths, path.canonical);
    const fileStat = await stat(path.canonical);
    if (!fileStat.isFile()) return { ok: false, output: `${input.path} is not a regular file.` };
    if (fileStat.size > MAX_FILE_BYTES) {
      return { ok: false, output: `${input.path} exceeds the ${MAX_FILE_BYTES}-byte edit limit.` };
    }
    const raw = await readFile(path.canonical);
    if (raw.includes(0)) return { ok: false, output: `${input.path} appears to be binary.` };
    const actualSha256 = sha256(raw);
    if (actualSha256 !== input.expected_sha256) {
      return {
        ok: false,
        output: `Conflict: ${input.path} changed since it was read (expected ${input.expected_sha256}, found ${actualSha256}).`,
      };
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return { ok: false, output: `${input.path} is not valid UTF-8 text.` };
    }

    const count = text.split(input.old_string).length - 1;
    if (count === 0) {
      return {
        ok: false,
        output: `old_string not found in ${input.path}. Re-read the file to get its current content.`,
      };
    }
    if (count > 1 && !input.replace_all) {
      return {
        ok: false,
        output: `old_string matches ${count} locations in ${input.path}; include more context or set replace_all=true.`,
      };
    }
    const next = input.replace_all
      ? text.split(input.old_string).join(input.new_string)
      : text.replace(input.old_string, input.new_string);

    try {
      const result = await applyFileMutations({
        cwd: path.workspaceRoot,
        runId: ctx.runId ?? 'unknown',
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        mutations: [
          {
            path: path.canonical,
            content: Buffer.from(next),
            expectedSha256: input.expected_sha256,
          },
        ],
        signal: ctx.signal,
        undoStore: ctx.undoStore,
      });
      const changed = result.files[0];
      const occurrences = input.replace_all ? count : 1;
      return {
        ok: true,
        output: `Replaced ${occurrences} occurrence(s) in ${input.path}. New sha256: ${changed?.afterSha256 ?? ''}. Undo ID: ${result.undoId}.`,
        meta: {
          path: path.canonical,
          occurrences,
          beforeSha256: actualSha256,
          afterSha256: changed?.afterSha256,
          undoId: result.undoId,
        },
      };
    } catch (error) {
      return { ok: false, output: `replace_in_file failed: ${(error as Error).message}` };
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
