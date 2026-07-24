import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import fg from 'fast-glob';
import createIgnore from 'ignore';

const DEFAULT_IGNORES = ['**/.git/**', '**/node_modules/**', '**/dist/**'];
const MAX_RG_BUFFER_BYTES = 5 * 1024 * 1024;
const MAX_FALLBACK_FILE_BYTES = 1024 * 1024;

export interface GlobQuery {
  root: string;
  pattern: string;
  ignore?: string[];
  hidden: boolean;
  limit: number;
  signal: AbortSignal;
}

export interface GlobSearchResult {
  files: string[];
  truncated: boolean;
  backend: 'rg' | 'node';
}

export interface GrepQuery {
  root: string;
  pattern: string;
  glob?: string;
  literal: boolean;
  caseSensitive: boolean;
  context: number;
  maxMatches: number;
  signal: AbortSignal;
}

export interface GrepHit {
  kind: 'match' | 'context';
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface GrepSearchResult {
  hits: GrepHit[];
  matches: number;
  truncated: boolean;
  backend: 'rg' | 'node';
}

export interface SearchAdapter {
  glob(query: GlobQuery): Promise<GlobSearchResult>;
  grep(query: GrepQuery): Promise<GrepSearchResult>;
}

export class HybridSearchAdapter implements SearchAdapter {
  constructor(private forceBackend?: 'rg' | 'node') {}

  async glob(query: GlobQuery): Promise<GlobSearchResult> {
    if (this.forceBackend === 'node') return nodeGlob(query);
    try {
      return await rgGlob(query);
    } catch (e) {
      if (this.forceBackend === 'rg' || !isMissingExecutable(e)) throw e;
      return nodeGlob(query);
    }
  }

  async grep(query: GrepQuery): Promise<GrepSearchResult> {
    if (this.forceBackend === 'node') return nodeGrep(query);
    try {
      return await rgGrep(query);
    } catch (e) {
      if (this.forceBackend === 'rg' || !isMissingExecutable(e)) throw e;
      return nodeGrep(query);
    }
  }
}

async function rgGlob(query: GlobQuery): Promise<GlobSearchResult> {
  const files: string[] = [];
  const args = [
    '--files',
    '--sort',
    'path',
    '--color',
    'never',
    '--no-require-git',
    '--glob',
    query.pattern,
    ...DEFAULT_IGNORES.flatMap((pattern) => ['--glob', `!${pattern}`]),
    ...(query.ignore ?? []).flatMap((pattern) => ['--glob', `!${pattern}`]),
    ...(query.hidden ? ['--hidden'] : []),
  ];
  const result = await runRgLines(args, query.root, query.signal, (line) => {
    if (line) files.push(normalizeSearchPath(line));
    return files.length < query.limit;
  });
  return {
    files: files.slice(0, query.limit),
    truncated: result.stoppedEarly,
    backend: 'rg',
  };
}

async function nodeGlob(query: GlobQuery): Promise<GlobSearchResult> {
  throwIfAborted(query.signal);
  const candidates = await fg(query.pattern, {
    cwd: query.root,
    onlyFiles: true,
    dot: query.hidden,
    unique: true,
    followSymbolicLinks: false,
    ignore: [...DEFAULT_IGNORES, ...(query.ignore ?? [])],
  });
  const ignores = await loadIgnoreMatchers(query.root);
  const files = candidates
    .map(normalizeSearchPath)
    .filter((path) => !isIgnored(path, ignores))
    .sort();
  throwIfAborted(query.signal);
  return {
    files: files.slice(0, query.limit),
    truncated: files.length > query.limit,
    backend: 'node',
  };
}

async function rgGrep(query: GrepQuery): Promise<GrepSearchResult> {
  const hits: GrepHit[] = [];
  let matches = 0;
  const args = [
    '--json',
    '--sort',
    'path',
    '--color',
    'never',
    '--line-number',
    '--column',
    '--no-require-git',
    ...(query.literal ? ['--fixed-strings'] : []),
    ...(query.caseSensitive ? ['--case-sensitive'] : ['--ignore-case']),
    ...(query.context ? ['--context', String(query.context)] : []),
    ...(query.glob ? ['--glob', query.glob] : []),
    ...DEFAULT_IGNORES.flatMap((pattern) => ['--glob', `!${pattern}`]),
    query.pattern,
    '.',
  ];
  const result = await runRgLines(args, query.root, query.signal, (line) => {
    const parsed = parseRgJsonLine(line);
    if (!parsed) return true;
    if (parsed.kind === 'match' && matches >= query.maxMatches) return false;
    hits.push(parsed);
    if (parsed.kind === 'match') matches++;
    return true;
  });
  return {
    hits,
    matches,
    truncated: result.stoppedEarly,
    backend: 'rg',
  };
}

async function nodeGrep(query: GrepQuery): Promise<GrepSearchResult> {
  const glob = await nodeGlob({
    root: query.root,
    pattern: query.glob ?? '**/*',
    hidden: false,
    limit: 100_000,
    signal: query.signal,
  });
  const expression = compilePattern(query.pattern, query.literal, query.caseSensitive);
  const hits: GrepHit[] = [];
  let matches = 0;

  for (const path of glob.files) {
    throwIfAborted(query.signal);
    const absolute = join(query.root, path);
    const fileStat = await stat(absolute).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size > MAX_FALLBACK_FILE_BYTES) continue;
    const raw = await readFile(absolute);
    if (raw.includes(0)) continue;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      continue;
    }
    const lines = text.split('\n');
    const matchedLines = new Map<number, number>();
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      expression.lastIndex = 0;
      const match = expression.exec(line);
      if (!match) continue;
      if (matches + matchedLines.size >= query.maxMatches) {
        appendFileHits(hits, path, lines, matchedLines, query.context);
        return {
          hits,
          matches: matches + matchedLines.size,
          truncated: true,
          backend: 'node',
        };
      }
      matchedLines.set(index, (match.index ?? 0) + 1);
    }
    appendFileHits(hits, path, lines, matchedLines, query.context);
    matches += matchedLines.size;
  }
  return { hits, matches, truncated: glob.truncated, backend: 'node' };
}

function appendFileHits(
  hits: GrepHit[],
  path: string,
  lines: string[],
  matchedLines: Map<number, number>,
  context: number,
): void {
  const relevant = new Set<number>();
  for (const index of matchedLines.keys()) {
    for (
      let contextIndex = Math.max(0, index - context);
      contextIndex <= Math.min(lines.length - 1, index + context);
      contextIndex++
    ) {
      relevant.add(contextIndex);
    }
  }
  for (const index of [...relevant].sort((a, b) => a - b)) {
    const column = matchedLines.get(index);
    hits.push({
      kind: column === undefined ? 'context' : 'match',
      path,
      line: index + 1,
      column: column ?? 0,
      text: lines[index] ?? '',
    });
  }
}

function compilePattern(pattern: string, literal: boolean, caseSensitive: boolean): RegExp {
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  try {
    return new RegExp(source, caseSensitive ? 'gu' : 'giu');
  } catch (e) {
    throw new Error(`Invalid grep pattern: ${(e as Error).message}`);
  }
}

interface IgnoreMatcher {
  base: string;
  matcher: ReturnType<typeof createIgnore>;
}

async function loadIgnoreMatchers(root: string): Promise<IgnoreMatcher[]> {
  const files = await fg('**/.gitignore', {
    cwd: root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: DEFAULT_IGNORES,
  });
  if (!files.includes('.gitignore')) files.unshift('.gitignore');
  const matchers: IgnoreMatcher[] = [];
  for (const file of files.sort()) {
    const normalized = normalizeSearchPath(file);
    const raw = await readFile(join(root, normalized), 'utf8').catch(() => '');
    if (!raw) continue;
    const slash = normalized.lastIndexOf('/');
    matchers.push({
      base: slash >= 0 ? normalized.slice(0, slash) : '',
      matcher: createIgnore().add(raw),
    });
  }
  matchers.unshift({ base: '', matcher: createIgnore().add(['.git/', 'node_modules/', 'dist/']) });
  return matchers;
}

function isIgnored(path: string, matchers: IgnoreMatcher[]): boolean {
  let ignored = false;
  for (const { base, matcher } of matchers) {
    if (base && path !== base && !path.startsWith(`${base}/`)) continue;
    const local = base ? path.slice(base.length + 1) : path;
    if (!local) continue;
    const result = matcher.test(local);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

interface RgJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
    submatches?: Array<{ start?: number }>;
  };
}

function parseRgJsonLine(line: string): GrepHit | null {
  let event: RgJsonEvent;
  try {
    event = JSON.parse(line) as RgJsonEvent;
  } catch {
    return null;
  }
  if (event.type !== 'match' && event.type !== 'context') return null;
  const path = event.data?.path?.text;
  const lineNumber = event.data?.line_number;
  if (!path || lineNumber === undefined) return null;
  const text = (event.data?.lines?.text ?? '').replace(/\r?\n$/, '');
  const byteColumn = event.data?.submatches?.[0]?.start ?? 0;
  return {
    kind: event.type,
    path: normalizeSearchPath(path),
    line: lineNumber,
    column:
      event.type === 'match'
        ? Buffer.from(text).subarray(0, byteColumn).toString('utf8').length + 1
        : 0,
    text,
  };
}

async function runRgLines(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onLine: (line: string) => boolean,
): Promise<{ stoppedEarly: boolean }> {
  throwIfAborted(signal);
  return new Promise((resolvePromise, reject) => {
    const child = spawn('rg', args, { cwd });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let stoppedEarly = false;
    let settled = false;

    const settleError = (error: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      settleError(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_RG_BUFFER_BYTES) {
        child.kill('SIGTERM');
        settleError(new Error('ripgrep output exceeded the 5 MiB safety limit'));
        return;
      }
      stdout += chunk.toString('utf8');
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!onLine(line)) {
          stoppedEarly = true;
          child.kill('SIGTERM');
          break;
        }
        newline = stdout.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4096);
    });
    child.on('error', (error) => settleError(error));
    child.on('close', (code, childSignal) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (stdout && !stoppedEarly) onLine(stdout);
      if (code === 0 || code === 1 || stoppedEarly || childSignal === 'SIGTERM') {
        resolvePromise({ stoppedEarly });
      } else {
        reject(new Error(`ripgrep failed with exit code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function normalizeSearchPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
