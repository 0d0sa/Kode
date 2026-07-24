import { readFile } from 'node:fs/promises';
import { extname, join, normalize, posix, relative } from 'node:path';
import type { DependencyEdge, DiscoveredFile, IndexedFile, RepositoryFacts } from './types.js';

const MANIFEST_NAMES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
]);
const MANIFEST_BYTES = 1024 * 1024;

export interface RepositoryAnalysis {
  facts: RepositoryFacts;
  manifestEdges: DependencyEdge[];
}

export async function analyzeRepository(
  root: string,
  files: readonly DiscoveredFile[],
  signal: AbortSignal,
): Promise<RepositoryAnalysis> {
  const paths = files.map((file) => file.path);
  const pathSet = new Set(paths);
  const manifests = paths.filter((path) => MANIFEST_NAMES.has(posix.basename(path))).sort();
  const stacks = detectStacks(paths, manifests);
  const workspaces = new Set<string>();
  const entrypoints = new Set<string>();
  const commands: Array<{ name: string; command: string }> = [];
  const manifestEdges: DependencyEdge[] = [];

  for (const manifest of manifests) {
    throwIfAborted(signal);
    const file = files.find((candidate) => candidate.path === manifest);
    if (!file || file.size > MANIFEST_BYTES) continue;
    const text = await readFile(file.absolute, 'utf8').catch(() => '');
    if (!text) continue;
    if (posix.basename(manifest) === 'package.json') {
      analyzePackageJson(manifest, text, pathSet, workspaces, entrypoints, commands, manifestEdges);
    } else if (posix.basename(manifest) === 'pnpm-workspace.yaml') {
      for (const match of text.matchAll(/^\s*-\s*["']?([^"'#\r\n]+)["']?\s*$/gm)) {
        const pattern = match[1]?.trim();
        if (pattern) workspaces.add(pattern);
      }
    } else if (posix.basename(manifest) === 'pyproject.toml') {
      const scriptSection = text.match(/\[project\.scripts\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? '';
      for (const match of scriptSection.matchAll(/^\s*([\w.-]+)\s*=\s*["']([^"']+)["']/gm)) {
        if (match[1] && match[2]) commands.push({ name: match[1], command: match[2] });
      }
    } else if (posix.basename(manifest) === 'go.mod') {
      const moduleName = text.match(/^\s*module\s+(\S+)/m)?.[1];
      if (moduleName) workspaces.add(moduleName);
    } else if (posix.basename(manifest) === 'Cargo.toml') {
      const packageName = text.match(/\[package\][\s\S]*?^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
      if (packageName) workspaces.add(packageName);
    }
  }

  for (const candidate of [
    'src/index.ts',
    'src/index.tsx',
    'src/index.js',
    'src/main.ts',
    'src/main.js',
    'index.ts',
    'index.js',
    'main.py',
    'src/main.py',
    'main.go',
    'cmd/main.go',
    'src/main.rs',
    'src/lib.rs',
  ]) {
    if (pathSet.has(candidate)) entrypoints.add(candidate);
  }

  return {
    facts: {
      stacks,
      manifests,
      workspaces: [...workspaces].sort().slice(0, 100),
      entrypoints: [...entrypoints].sort().slice(0, 100),
      commands: uniqueCommands(commands).slice(0, 100),
      topLevelModules: topLevelModules(paths),
    },
    manifestEdges,
  };
}

export function resolveDependencyTargets(
  files: ReadonlyMap<string, IndexedFile>,
  manifestEdges: readonly DependencyEdge[],
): DependencyEdge[] {
  const paths = new Set(files.keys());
  const output: DependencyEdge[] = [];
  for (const file of files.values()) {
    for (const edge of file.dependencies) {
      const to = resolveSpecifier(edge.from, edge.specifier, file.language, paths);
      output.push({ ...edge, ...(to ? { to } : {}) });
    }
  }
  output.push(...manifestEdges);
  return output.sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.specifier.localeCompare(right.specifier) ||
      left.kind.localeCompare(right.kind),
  );
}

function analyzePackageJson(
  path: string,
  text: string,
  paths: ReadonlySet<string>,
  workspaces: Set<string>,
  entrypoints: Set<string>,
  commands: Array<{ name: string; command: string }>,
  edges: DependencyEdge[],
): void {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  const base = posix.dirname(path) === '.' ? '' : posix.dirname(path);
  const workspaceValue = value.workspaces;
  const patterns = Array.isArray(workspaceValue)
    ? workspaceValue
    : isRecord(workspaceValue) && Array.isArray(workspaceValue.packages)
      ? workspaceValue.packages
      : [];
  for (const pattern of patterns) {
    if (typeof pattern === 'string') workspaces.add(pattern);
  }
  for (const key of ['main', 'module', 'types']) {
    const target = value[key];
    if (typeof target !== 'string') continue;
    const candidate = posix.normalize(posix.join(base, stripDot(target)));
    if (paths.has(candidate)) entrypoints.add(candidate);
  }
  const bin = value.bin;
  if (typeof bin === 'string') {
    const candidate = posix.normalize(posix.join(base, stripDot(bin)));
    if (paths.has(candidate)) entrypoints.add(candidate);
  } else if (isRecord(bin)) {
    for (const target of Object.values(bin)) {
      if (typeof target !== 'string') continue;
      const candidate = posix.normalize(posix.join(base, stripDot(target)));
      if (paths.has(candidate)) entrypoints.add(candidate);
    }
  }
  if (!base) {
    const scripts = value.scripts;
    if (isRecord(scripts)) {
      for (const [name, command] of Object.entries(scripts)) {
        if (typeof command === 'string') commands.push({ name, command: command.slice(0, 240) });
      }
    }
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const dependencies = value[field];
    if (!isRecord(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      edges.push({
        from: path,
        specifier: name,
        kind: 'manifest',
        confidence: 'exact',
      });
    }
  }
}

function resolveSpecifier(
  from: string,
  specifier: string,
  language: IndexedFile['language'],
  paths: ReadonlySet<string>,
): string | undefined {
  const base = posix.dirname(from);
  if (language === 'typescript' || language === 'javascript') {
    if (!specifier.startsWith('.')) return undefined;
    const target = posix.normalize(posix.join(base, specifier));
    const targets = [target];
    if (target.endsWith('.js')) {
      targets.push(`${target.slice(0, -3)}.ts`, `${target.slice(0, -3)}.tsx`);
    } else if (target.endsWith('.mjs')) {
      targets.push(`${target.slice(0, -4)}.mts`);
    } else if (target.endsWith('.cjs')) {
      targets.push(`${target.slice(0, -4)}.cts`);
    }
    for (const candidate of targets) {
      const resolved = firstExisting(candidate, paths, [
        '',
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '/index.ts',
        '/index.tsx',
        '/index.js',
        '/index.jsx',
      ]);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (language === 'python') {
    const leading = specifier.match(/^\.+/)?.[0].length ?? 0;
    const module = specifier.slice(leading).replaceAll('.', '/');
    let parent = base;
    for (let index = 1; index < leading; index++) parent = posix.dirname(parent);
    const target = posix.join(parent, module);
    return firstExisting(target, paths, ['.py', '/__init__.py']);
  }
  if (language === 'rust' && /^[A-Za-z_]\w*$/.test(specifier)) {
    return firstExisting(posix.join(base, specifier), paths, ['.rs', '/mod.rs']);
  }
  return undefined;
}

function firstExisting(
  target: string,
  paths: ReadonlySet<string>,
  suffixes: readonly string[],
): string | undefined {
  for (const suffix of suffixes) {
    const candidate = `${target}${suffix}`;
    if (paths.has(candidate)) return candidate;
  }
  return undefined;
}

function detectStacks(paths: readonly string[], manifests: readonly string[]): string[] {
  const stacks = new Set<string>();
  if (paths.some((path) => ['.ts', '.tsx', '.mts', '.cts'].includes(extname(path)))) {
    stacks.add('TypeScript');
  }
  if (paths.some((path) => ['.js', '.jsx', '.mjs', '.cjs'].includes(extname(path)))) {
    stacks.add('JavaScript');
  }
  if (paths.some((path) => ['.py', '.pyi'].includes(extname(path)))) stacks.add('Python');
  if (paths.some((path) => extname(path) === '.go')) stacks.add('Go');
  if (paths.some((path) => extname(path) === '.rs')) stacks.add('Rust');
  if (manifests.some((path) => posix.basename(path) === 'package.json')) stacks.add('Node.js');
  if (manifests.some((path) => posix.basename(path) === 'Cargo.toml')) stacks.add('Cargo');
  return [...stacks].sort();
}

function topLevelModules(paths: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const [first] = path.split('/');
    if (!first || first === path || first.startsWith('.')) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  return [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 40)
    .map(([name, count]) => `${name}/ (${count} files)`);
}

function uniqueCommands(
  commands: Array<{ name: string; command: string }>,
): Array<{ name: string; command: string }> {
  const seen = new Set<string>();
  return commands.filter(({ name }) => !seen.has(name) && Boolean(seen.add(name)));
}

function stripDot(path: string): string {
  return path.replace(/^\.\//, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

/** Convert an absolute path below root into the repository's POSIX path convention. */
export function relativeRepositoryPath(root: string, absolute: string): string {
  return normalize(relative(root, absolute)).split('\\').join('/');
}

export function absoluteRepositoryPath(root: string, path: string): string {
  return join(root, ...path.split('/'));
}
