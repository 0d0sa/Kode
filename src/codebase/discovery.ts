import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodebaseLanguage } from '../config/schema.js';
import { discoverWorkspaceFiles } from '../tools/search/adapter.js';
import type { DiscoveredFile } from './types.js';

export interface DiscoveryOptions {
  maxFiles: number;
  ignore: string[];
  languages: ReadonlySet<CodebaseLanguage>;
}

export interface DiscoveryResult {
  root: string;
  files: DiscoveredFile[];
  truncated: boolean;
}

export async function discoverCodebase(
  cwd: string,
  options: DiscoveryOptions,
  signal: AbortSignal,
): Promise<DiscoveryResult> {
  throwIfAborted(signal);
  const root = await realpath(cwd);
  const result = await discoverWorkspaceFiles({
    root,
    ignore: options.ignore,
    hidden: true,
    limit: options.maxFiles + 1,
    signal,
  });
  const files: DiscoveredFile[] = [];
  for (const path of result.files.slice(0, options.maxFiles)) {
    throwIfAborted(signal);
    const absolute = join(root, path);
    const fileStat = await lstat(absolute).catch(() => null);
    if (!fileStat?.isFile() || fileStat.isSymbolicLink()) continue;
    const detected = detectLanguage(path);
    files.push({
      path,
      absolute,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      ...(detected && options.languages.has(detected.language) ? detected : {}),
    });
  }
  return {
    root,
    files,
    truncated: result.truncated || result.files.length > options.maxFiles,
  };
}

export function detectLanguage(path: string):
  | {
      language: CodebaseLanguage;
      grammar: NonNullable<DiscoveredFile['grammar']>;
    }
  | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return { language: 'typescript', grammar: 'tsx' };
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return { language: 'typescript', grammar: 'typescript' };
  }
  if (lower.endsWith('.jsx')) return { language: 'javascript', grammar: 'javascript' };
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return { language: 'javascript', grammar: 'javascript' };
  }
  if (lower.endsWith('.py') || lower.endsWith('.pyi')) {
    return { language: 'python', grammar: 'python' };
  }
  if (lower.endsWith('.go')) return { language: 'go', grammar: 'go' };
  if (lower.endsWith('.rs')) return { language: 'rust', grammar: 'rust' };
  return undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}
