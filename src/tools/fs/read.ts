import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { PermissionPath } from '../../permission/types.js';
import { assertAuthorizedToolPath, resolveToolPath } from '../path.js';
import { toInputSchema, type Tool } from '../types.js';

const MAX_LINES = 2000;
const MAX_OUTPUT_BYTES = 100 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

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
    'Read a UTF-8 text file with 1-based line numbers. Returns a sha256 hash for safe follow-up edits; use offset/limit to page large files.',
  schema,
  inputSchema: toInputSchema(schema),
  isReadOnly: true,
  async permission(input, ctx) {
    const path = await resolveToolPath(ctx.cwd, input.path);
    return { kind: 'read', paths: [permissionPath(path)] };
  },
  async execute(input, ctx) {
    const path = await resolveToolPath(ctx.cwd, input.path).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      },
    );
    if (!path) return { ok: false, output: `File not found: ${input.path}` };
    assertAuthorizedToolPath(ctx.authorizedPaths, path.canonical);
    const fileStat = await stat(path.canonical);
    if (fileStat.isDirectory()) {
      return { ok: false, output: `${input.path} is a directory; use glob to list files.` };
    }
    if (!fileStat.isFile()) return { ok: false, output: `${input.path} is not a regular file.` };
    if (fileStat.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        output: `File is too large to read safely (${fileStat.size} bytes; limit ${MAX_FILE_BYTES}).`,
      };
    }

    try {
      const result = await streamTextFile(
        path.canonical,
        input.offset ?? 1,
        input.limit ?? MAX_LINES,
        ctx.signal,
      );
      let output = result.lines.join('\n');
      const end = result.selectedEnd;
      if (result.byteCapped && result.lines.length === 0) {
        output += `[truncated: line ${input.offset ?? 1} exceeds the output byte cap; file has ${result.totalLines} line(s)]`;
      } else if (end < result.totalLines || result.byteCapped) {
        output += `${output ? '\n' : ''}[truncated: showing lines ${input.offset ?? 1}-${end} of ${result.totalLines}${result.byteCapped ? ', byte-capped' : ''}]`;
      }
      output += `${output ? '\n' : ''}[sha256: ${result.sha256}]`;
      return {
        ok: true,
        output,
        meta: {
          path: path.canonical,
          size: fileStat.size,
          mtime: fileStat.mtime.toISOString(),
          sha256: result.sha256,
          totalLines: result.totalLines,
        },
      };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return { ok: false, output: 'read_file was aborted.' };
      }
      return { ok: false, output: `Cannot read ${input.path}: ${(error as Error).message}` };
    }
  },
};

async function streamTextFile(
  path: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<{
  lines: string[];
  totalLines: number;
  selectedEnd: number;
  byteCapped: boolean;
  sha256: string;
}> {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const output: string[] = [];
  let carry = '';
  let lineNumber = 0;
  let outputBytes = 0;
  let byteCapped = false;

  const processLine = (line: string) => {
    lineNumber++;
    if (lineNumber < offset || lineNumber >= offset + limit || byteCapped) return;
    const formatted = `${lineNumber}: ${line}`;
    const bytes = Buffer.byteLength(formatted) + (output.length ? 1 : 0);
    if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
      byteCapped = true;
      return;
    }
    output.push(formatted);
    outputBytes += bytes;
  };

  for await (const chunk of createReadStream(path, { signal })) {
    const bytes = chunk as Buffer;
    if (bytes.includes(0)) throw new Error('file appears to be binary');
    hash.update(bytes);
    carry += decoder.decode(bytes, { stream: true });
    let newline = carry.indexOf('\n');
    while (newline >= 0) {
      const line = carry.slice(0, newline).replace(/\r$/, '');
      processLine(line);
      carry = carry.slice(newline + 1);
      newline = carry.indexOf('\n');
    }
    if (Buffer.byteLength(carry) > MAX_LINE_BYTES) {
      throw new Error(`line exceeds the ${MAX_LINE_BYTES}-byte safety limit`);
    }
  }
  carry += decoder.decode();
  processLine(carry.replace(/\r$/, ''));

  return {
    lines: output,
    totalLines: lineNumber,
    selectedEnd: output.length ? offset + output.length - 1 : Math.min(offset - 1, lineNumber),
    byteCapped,
    sha256: hash.digest('hex'),
  };
}

function permissionPath(path: Awaited<ReturnType<typeof resolveToolPath>>): PermissionPath {
  return {
    canonical: path.canonical,
    relative: path.relative,
    outsideWorkspace: path.outsideWorkspace,
  };
}
