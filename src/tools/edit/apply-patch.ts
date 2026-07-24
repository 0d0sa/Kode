import { readFile, stat } from 'node:fs/promises';
import { applyPatch as applyUnifiedPatch, parsePatch, type StructuredPatch } from 'diff';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { PermissionPath } from '../../permission/types.js';
import { applyFileMutations, sha256, type FileMutation } from '../mutation.js';
import { assertAuthorizedToolPath, resolveToolPath } from '../path.js';
import { toInputSchema, type Tool, type ToolContext } from '../types.js';

const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_FILES = 100;
const MAX_TARGET_BYTES = 20 * 1024 * 1024;

const schema = z.object({
  patch: z
    .string()
    .min(1)
    .max(MAX_PATCH_BYTES)
    .describe('Unified diff containing one or more text-file changes'),
});

interface PlannedPatch {
  mutations: FileMutation[];
  displayPaths: string[];
  workspaceRoot: string;
}

export const applyPatchTool: Tool<z.infer<typeof schema>> = {
  name: 'apply_patch',
  description:
    'Apply a unified diff atomically across one or more UTF-8 text files. All hunks are dry-run before any file changes.',
  schema,
  inputSchema: toInputSchema(schema),
  isReadOnly: false,
  async permission(input, ctx) {
    const patches = parseAndValidate(input.patch);
    const paths = await Promise.all(
      patches.map(async (patch) => {
        const target = targetPath(patch);
        const resolved = await resolveToolPath(ctx.cwd, target, {
          allowMissing: patch.oldFileName === '/dev/null' || patch.isCreate === true,
        });
        return permissionPath(resolved);
      }),
    );
    return { kind: 'write', paths };
  },
  async execute(input, ctx) {
    if (ctx.signal.aborted) return { ok: false, output: 'apply_patch was aborted.' };
    if (!ctx.undoStore) {
      return { ok: false, output: 'apply_patch failed: undo storage is unavailable.' };
    }
    try {
      const plan = await planPatch(ctx, input.patch);
      if (ctx.signal.aborted) return { ok: false, output: 'apply_patch was aborted.' };
      const result = await applyFileMutations({
        cwd: plan.workspaceRoot,
        runId: ctx.runId ?? 'unknown',
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        mutations: plan.mutations,
        signal: ctx.signal,
        undoStore: ctx.undoStore,
        ...(ctx.markFilesDirty ? { onCommitted: ctx.markFilesDirty } : {}),
      });
      return {
        ok: true,
        output: `Applied patch to ${plan.displayPaths.length} file(s): ${plan.displayPaths.join(', ')}. Undo ID: ${result.undoId}.`,
        meta: { files: result.files, undoId: result.undoId },
      };
    } catch (error) {
      return { ok: false, output: `apply_patch failed: ${(error as Error).message}` };
    }
  },
};

async function planPatch(ctx: ToolContext, source: string): Promise<PlannedPatch> {
  const patches = parseAndValidate(source);
  const mutations: FileMutation[] = [];
  const displayPaths: string[] = [];
  let workspaceRoot = '';

  for (const patch of patches) {
    if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const displayPath = targetPath(patch);
    const isCreate = patch.oldFileName === '/dev/null' || patch.isCreate === true;
    const isDelete = patch.newFileName === '/dev/null' || patch.isDelete === true;
    const resolved = await resolveToolPath(ctx.cwd, displayPath, { allowMissing: isCreate });
    assertAuthorizedToolPath(ctx.authorizedPaths, resolved.canonical);
    workspaceRoot ||= resolved.workspaceRoot;
    if (isCreate && resolved.exists) throw new Error(`Cannot create existing file: ${displayPath}`);
    if (!isCreate && !resolved.exists) throw new Error(`File not found: ${displayPath}`);

    let current = Buffer.alloc(0);
    if (resolved.exists) {
      const fileStat = await stat(resolved.canonical);
      if (!fileStat.isFile()) throw new Error(`${displayPath} is not a regular file`);
      if (fileStat.size > MAX_TARGET_BYTES) {
        throw new Error(`${displayPath} exceeds the ${MAX_TARGET_BYTES}-byte patch limit`);
      }
      current = await readFile(resolved.canonical);
      if (current.includes(0)) throw new Error(`${displayPath} appears to be binary`);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(current);
    } catch {
      throw new Error(`${displayPath} is not valid UTF-8 text`);
    }
    const next = applyUnifiedPatch(text, patch, { fuzzFactor: 0 });
    if (next === false) throw new Error(`One or more hunks did not match ${displayPath}`);

    mutations.push({
      path: resolved.canonical,
      content: isDelete ? null : Buffer.from(next),
      ...(resolved.exists ? { expectedSha256: sha256(current) } : {}),
    });
    displayPaths.push(displayPath);
  }
  return { mutations, displayPaths, workspaceRoot };
}

function parseAndValidate(source: string): StructuredPatch[] {
  if (Buffer.byteLength(source) > MAX_PATCH_BYTES) {
    throw new Error(`Patch exceeds the ${MAX_PATCH_BYTES}-byte limit`);
  }
  const patches = parsePatch(source);
  if (!patches.length) throw new Error('No unified diff file sections found');
  if (patches.length > MAX_FILES) throw new Error(`Patch targets more than ${MAX_FILES} files`);

  for (const patch of patches) {
    if (patch.isBinary) throw new Error('Binary patches are not supported');
    if (patch.isRename || patch.isCopy)
      throw new Error('Rename and copy patches are not supported');
    if (patch.oldMode || patch.newMode) throw new Error('File mode changes are not supported');
    const oldPath = normalizePatchPath(patch.oldFileName);
    const newPath = normalizePatchPath(patch.newFileName);
    if (oldPath !== '/dev/null' && newPath !== '/dev/null' && oldPath !== newPath) {
      throw new Error(`Rename patches are not supported: ${oldPath} -> ${newPath}`);
    }
    if (!patch.hunks.length) throw new Error(`Patch for ${targetPath(patch)} contains no hunks`);
  }
  return patches;
}

function targetPath(patch: StructuredPatch): string {
  const oldPath = normalizePatchPath(patch.oldFileName);
  const newPath = normalizePatchPath(patch.newFileName);
  return newPath === '/dev/null' ? oldPath : newPath;
}

function normalizePatchPath(path: string | undefined): string {
  if (!path) throw new Error('Patch section is missing a file path');
  if (path === '/dev/null') return path;
  const stripped = path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
  if (!stripped || isAbsolute(stripped))
    throw new Error(`Absolute patch path is not allowed: ${path}`);
  const segments = stripped.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error(`Unsafe patch path: ${path}`);
  }
  return stripped;
}

function permissionPath(path: Awaited<ReturnType<typeof resolveToolPath>>): PermissionPath {
  return {
    canonical: path.canonical,
    relative: path.relative,
    outsideWorkspace: path.outsideWorkspace,
  };
}
