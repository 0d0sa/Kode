import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { toInputSchema, type Tool } from '../types.js';

const MAX_LINES = 2000;
const MAX_BYTES = 100 * 1024;

const schema = z.object({
  path: z.string().min(1).describe('File path, relative to the working directory or absolute'),
  offset: z.number().int().min(1).optional().describe('1-based start line, default 1'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LINES)
    .optional()
    .describe('Max lines to return, default 2000'),
});

export const readFileTool: Tool<z.infer<typeof schema>> = {
  name: 'read_file',
  description:
    'Read a text file and return its content with 1-based line numbers. Use offset/limit to page through large files.',
  schema,
  inputSchema: toInputSchema(schema),
  isReadOnly: true,
  async execute(input, ctx) {
    const p = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    const st = await stat(p).catch(() => null);
    if (!st) return { ok: false, output: `File not found: ${input.path}` };
    if (st.isDirectory()) {
      return {
        ok: false,
        output: `${input.path} is a directory (directory listing arrives in Phase 2).`,
      };
    }
    const raw = await readFile(p, 'utf8');
    const lines = raw.split('\n');
    const offset = input.offset ?? 1;
    const limit = Math.min(input.limit ?? MAX_LINES, MAX_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    let out = slice.map((l, i) => `${offset + i}: ${l}`).join('\n');
    let byteCapped = false;
    if (out.length > MAX_BYTES) {
      out = out.slice(0, MAX_BYTES);
      byteCapped = true;
    }
    const end = offset + slice.length - 1;
    if (end < lines.length || byteCapped) {
      out += `\n[truncated: showing lines ${offset}-${end} of ${lines.length}${byteCapped ? ', byte-capped' : ''}]`;
    }
    return { ok: true, output: out, meta: { path: p, totalLines: lines.length } };
  },
};
