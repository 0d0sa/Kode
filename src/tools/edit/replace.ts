import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { toInputSchema, type Tool } from '../types.js';

const schema = z.object({
  path: z.string().min(1).describe('File path, relative to the working directory or absolute'),
  old_string: z.string().min(1).describe('Exact text to find; must match exactly one location'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace all occurrences instead of requiring a unique match'),
});

export const replaceInFileTool: Tool<z.infer<typeof schema>> = {
  name: 'replace_in_file',
  description:
    'Replace an exact string in a file. Fails unless old_string matches exactly one location (use replace_all for multiple). Always read_file first to confirm the exact current text.',
  schema,
  inputSchema: toInputSchema(schema),
  isReadOnly: false,
  async execute(input, ctx) {
    if (ctx.signal.aborted) return { ok: false, output: 'replace_in_file was aborted.' };
    const p = isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path);
    const raw = await readFile(p, 'utf8').catch(() => null);
    if (raw === null) return { ok: false, output: `File not found: ${input.path}` };
    if (ctx.signal.aborted) return { ok: false, output: 'replace_in_file was aborted.' };

    const count = raw.split(input.old_string).length - 1;
    if (count === 0) {
      return {
        ok: false,
        output: `old_string not found in ${input.path}. Re-read the file to get the exact current content.`,
      };
    }
    if (count > 1 && !input.replace_all) {
      return {
        ok: false,
        output: `old_string matches ${count} locations in ${input.path}; include more surrounding context to make it unique, or set replace_all=true.`,
      };
    }
    const next = input.replace_all
      ? raw.split(input.old_string).join(input.new_string)
      : raw.replace(input.old_string, input.new_string);
    if (ctx.signal.aborted) return { ok: false, output: 'replace_in_file was aborted.' };
    await writeFile(p, next, 'utf8');
    const n = input.replace_all ? count : 1;
    return {
      ok: true,
      output: `Replaced ${n} occurrence(s) in ${input.path}.`,
      meta: { path: p, occurrences: n },
    };
  },
};
