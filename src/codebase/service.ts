import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Logger } from 'pino';
import type { CodebaseConfig, CodebaseLanguage } from '../config/schema.js';
import type { ContextSource } from '../context/types.js';
import { discoverCodebase, type DiscoveryResult } from './discovery.js';
import { CodebaseIndexError } from './errors.js';
import { analyzeRepository, relativeRepositoryPath, resolveDependencyTargets } from './graph.js';
import { PARSER_DIGEST, parseSource } from './languages/registry.js';
import { buildRepositoryOverview } from './overview.js';
import { SqliteIndexStore } from './store.js';
import type {
  CodeReference,
  CodeSymbol,
  DefinitionQuery,
  DependencyQuery,
  DependencyResult,
  DiscoveredFile,
  IndexStatus,
  IndexedFile,
  ReferenceQuery,
  RepositoryOverview,
  RepositorySnapshot,
  ResultPage,
  SymbolQuery,
} from './types.js';

const DEFAULT_LANGUAGES: CodebaseLanguage[] = ['typescript', 'javascript', 'python', 'go', 'rust'];

export interface ResolvedCodebaseOptions {
  enabled: boolean;
  languages: CodebaseLanguage[];
  cache: 'global' | 'memory';
  refresh: 'incremental' | 'full';
  maxFiles: number;
  maxFileBytes: number;
  parseConcurrency: number;
  overviewTokens: number;
  ignore: string[];
}

export interface CodebaseServiceOptions {
  cacheRoot?: string;
}

export class CodebaseService {
  private readonly options: ResolvedCodebaseOptions;
  private readonly log: Logger;
  private readonly closeController = new AbortController();
  private root = '';
  private rootDigest = '';
  private configDigest: string;
  private store?: SqliteIndexStore;
  private snapshot: RepositorySnapshot = emptySnapshot();
  private state: IndexStatus['state'] = 'empty';
  private warnings: string[] = [];
  private discoveredFiles = 0;
  private discoveryTruncated = false;
  private startPromise: Promise<void> | undefined;
  private buildPromise: Promise<void> | undefined;
  private dirtyAbsolute = new Set<string>();
  private closed = false;

  constructor(
    private readonly cwd: string,
    config: CodebaseConfig | undefined,
    logger: Logger,
    private readonly serviceOptions: CodebaseServiceOptions = {},
  ) {
    this.options = resolveCodebaseOptions(config);
    this.configDigest = digestConfig(this.options);
    this.log = logger.child({ component: 'codebase' });
  }

  async start(signal?: AbortSignal): Promise<RepositorySnapshot> {
    if (!this.options.enabled) {
      throw new CodebaseIndexError(
        'Codebase indexing is disabled by configuration.',
        'index_disabled',
      );
    }
    if (this.closed) throw new Error('Codebase service is closed');
    this.startPromise ??= this.initialize(signal).catch((error) => {
      this.startPromise = undefined;
      throw error;
    });
    await this.startPromise;
    return this.snapshot;
  }

  status(): IndexStatus {
    const files = [...this.snapshot.files.values()];
    const supportedFiles = files.filter((file) => file.language).length;
    const indexedFiles = files.filter((file) => file.parseStatus === 'ok').length;
    const failedFiles = files.filter((file) => file.parseStatus === 'failed').length;
    const staleFiles = this.dirtyPaths().size;
    return {
      state: staleFiles > 0 && this.state === 'ready' ? 'stale' : this.state,
      generation: this.snapshot.generation,
      indexedFiles,
      discoveredFiles: this.discoveredFiles || files.length,
      supportedFiles,
      failedFiles,
      staleFiles,
      coverage: supportedFiles === 0 ? 1 : indexedFiles / supportedFiles,
      warnings: [...this.warnings],
    };
  }

  markDirty(paths: readonly string[]): void {
    if (this.closed) return;
    for (const path of paths) this.dirtyAbsolute.add(path);
    if (paths.length > 0 && this.state === 'ready') this.state = 'stale';
  }

  async reconcile(signal?: AbortSignal): Promise<IndexStatus> {
    await this.start(signal);
    throwIfAborted(signal);
    if (this.buildPromise) await awaitWithSignal(this.buildPromise, signal);
    const discovery = await discoverCodebase(
      this.root,
      {
        maxFiles: this.options.maxFiles,
        ignore: this.options.ignore,
        languages: new Set(this.options.languages),
      },
      requiredSignal(signal),
    );
    if (needsBuild(this.snapshot, discovery, this.dirtyPaths(), this.options.refresh)) {
      await this.build(discovery, requiredSignal(signal));
    } else {
      this.discoveredFiles = discovery.files.length;
      this.discoveryTruncated = discovery.truncated;
      this.updateTruncationWarning();
      this.state = this.warnings.length > 0 ? 'degraded' : 'ready';
    }
    return this.status();
  }

  async overview(signal?: AbortSignal): Promise<RepositoryOverview> {
    await this.start(signal);
    if (this.dirtyPaths().size > 0) await this.reconcile(signal);
    return buildRepositoryOverview(this.snapshot, this.status(), this.options.overviewTokens);
  }

  async contextSource(signal?: AbortSignal): Promise<ContextSource> {
    const overview = await this.overview(signal);
    return {
      id: 'repository',
      priority: 'high',
      version: overview.version,
      content: overview.content,
      maxTokens: this.options.overviewTokens,
      strategy: 'truncate-structured',
      placement: 'current-user-prefix',
    };
  }

  async listSymbols(query: SymbolQuery, signal?: AbortSignal): Promise<ResultPage<CodeSymbol>> {
    await this.reconcile(signal);
    const path = query.path ? normalizeQueryPath(query.path) : undefined;
    const limit = boundedLimit(query.limit, 100);
    const digest = queryDigest({ ...query, cursor: undefined, path });
    const offset = decodeCursor(query.cursor, this.snapshot.generation, digest);
    const filtered = this.snapshot.symbols.filter(
      (symbol) =>
        pathMatches(symbol.location.path, path) &&
        (!query.name ||
          symbol.name.toLowerCase().includes(query.name.toLowerCase()) ||
          symbol.qualifiedName?.toLowerCase().includes(query.name.toLowerCase())) &&
        (!query.kind || symbol.kind === query.kind),
    );
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
      items,
      ...(nextOffset < filtered.length
        ? { nextCursor: encodeCursor(this.snapshot.generation, digest, nextOffset) }
        : {}),
      truncated: nextOffset < filtered.length,
      status: this.status(),
    };
  }

  async findDefinitions(
    query: DefinitionQuery,
    signal?: AbortSignal,
  ): Promise<ResultPage<CodeSymbol>> {
    await this.reconcile(signal);
    const fromPath = query.fromPath ? normalizeQueryPath(query.fromPath) : undefined;
    const directTargets = new Set(
      this.snapshot.dependencies
        .filter((edge) => edge.from === fromPath && edge.to)
        .map((edge) => edge.to as string),
    );
    const items = this.snapshot.symbols
      .filter((symbol) => symbol.name === query.name || symbol.qualifiedName === query.name)
      .sort(
        (left, right) =>
          definitionRank(left, fromPath, directTargets) -
            definitionRank(right, fromPath, directTargets) || compareSymbol(left, right),
      );
    const limit = boundedLimit(query.limit, 50);
    return {
      items: items.slice(0, limit),
      truncated: items.length > limit,
      status: this.status(),
    };
  }

  async findReferences(
    query: ReferenceQuery,
    signal?: AbortSignal,
  ): Promise<ResultPage<CodeReference | CodeSymbol>> {
    await this.reconcile(signal);
    const path = query.path ? normalizeQueryPath(query.path) : undefined;
    const digest = queryDigest({ ...query, cursor: undefined, path });
    const offset = decodeCursor(query.cursor, this.snapshot.generation, digest);
    const references: Array<CodeReference | CodeSymbol> = this.snapshot.references.filter(
      (reference) => reference.name === query.name && pathMatches(reference.location.path, path),
    );
    if (query.includeDeclaration) {
      references.unshift(
        ...this.snapshot.symbols.filter(
          (symbol) => symbol.name === query.name && pathMatches(symbol.location.path, path),
        ),
      );
    }
    references.sort(compareLocated);
    const limit = boundedLimit(query.limit, 100);
    const items = references.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
      items,
      ...(nextOffset < references.length
        ? { nextCursor: encodeCursor(this.snapshot.generation, digest, nextOffset) }
        : {}),
      truncated: nextOffset < references.length,
      status: this.status(),
    };
  }

  async dependencies(query: DependencyQuery, signal?: AbortSignal): Promise<DependencyResult> {
    await this.reconcile(signal);
    const path = normalizeQueryPath(query.path);
    const direction = query.direction ?? 'both';
    const depth = Math.min(3, Math.max(1, query.depth ?? 1));
    const limit = boundedLimit(query.limit, 200);
    const selected: typeof this.snapshot.dependencies = [];
    const seen = new Set<string>();
    let frontier = new Set([path]);
    for (let level = 0; level < depth && frontier.size > 0 && selected.length < limit; level++) {
      const next = new Set<string>();
      for (const edge of this.snapshot.dependencies) {
        const outgoing =
          direction !== 'incoming' && [...frontier].some((item) => pathMatches(edge.from, item));
        const incoming =
          direction !== 'outgoing' &&
          edge.to !== undefined &&
          [...frontier].some((item) => pathMatches(edge.to as string, item));
        if (!outgoing && !incoming) continue;
        const key = `${edge.from}\0${edge.to ?? ''}\0${edge.specifier}\0${edge.kind}`;
        if (!seen.has(key)) {
          seen.add(key);
          selected.push(edge);
        }
        if (outgoing && edge.to) next.add(edge.to);
        if (incoming) next.add(edge.from);
        if (selected.length >= limit) break;
      }
      frontier = next;
    }
    return {
      edges: selected.slice(0, limit),
      truncated: selected.length >= limit,
      status: this.status(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort();
    await this.buildPromise?.catch(() => undefined);
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.root = await realpath(this.cwd);
    this.rootDigest = createHash('sha256').update(this.root).digest('hex');
    const discovery = await discoverCodebase(
      this.root,
      {
        maxFiles: this.options.maxFiles,
        ignore: this.options.ignore,
        languages: new Set(this.options.languages),
      },
      requiredSignal(signal),
    );
    this.discoveredFiles = discovery.files.length;
    this.discoveryTruncated = discovery.truncated;
    const analysis = await analyzeRepository(this.root, discovery.files, requiredSignal(signal));
    if (this.options.cache === 'global') {
      this.store = new SqliteIndexStore({
        root: this.root,
        rootDigest: this.rootDigest,
        parserDigest: PARSER_DIGEST,
        configDigest: this.configDigest,
        ...(this.serviceOptions.cacheRoot ? { cacheRoot: this.serviceOptions.cacheRoot } : {}),
      });
      try {
        const cached = await this.store.load();
        if (cached) this.snapshot = { ...cached, facts: analysis.facts };
      } catch {
        this.addWarning('Persistent index cache could not be loaded; using an in-memory rebuild.');
      }
    }
    if (this.snapshot.generation === 'none') {
      this.snapshot = {
        ...emptySnapshot(),
        rootDigest: this.rootDigest,
        parserDigest: PARSER_DIGEST,
        configDigest: this.configDigest,
        facts: analysis.facts,
        files: structuralFiles(discovery.files, this.options.maxFileBytes),
      };
    }
    this.updateTruncationWarning();
    if (needsBuild(this.snapshot, discovery, this.dirtyPaths(), this.options.refresh)) {
      this.state = 'building';
      this.buildPromise = this.build(discovery, this.closeController.signal).catch((error) => {
        if (isAbort(error) && this.closed) return;
        this.state = 'degraded';
        this.addWarning(
          'Background index build failed; cached or structural results remain active.',
        );
        this.log.warn({ errorType: errorName(error) }, 'codebase index build failed');
      });
    } else {
      this.state = this.warnings.length > 0 ? 'degraded' : 'ready';
    }
  }

  private async build(discovery: DiscoveryResult, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const started = Date.now();
    this.state = 'building';
    const dirtyAbsoluteAtStart = new Set(this.dirtyAbsolute);
    const dirty = this.dirtyPaths();
    const previous = this.snapshot.files;
    const analysis = await analyzeRepository(this.root, discovery.files, signal);
    const entries = await mapLimit(
      discovery.files,
      this.options.parseConcurrency,
      (file) => this.indexFile(file, previous.get(file.path), dirty, signal),
      signal,
    );
    const files = new Map(entries.map((file) => [file.path, file]));
    const dependencies = resolveDependencyTargets(files, analysis.manifestEdges);
    const symbols = [...files.values()].flatMap((file) => file.symbols).sort(compareSymbol);
    const definitions = new Map<string, CodeSymbol[]>();
    for (const symbol of symbols) {
      const list = definitions.get(symbol.name) ?? [];
      list.push(symbol);
      definitions.set(symbol.name, list);
    }
    const references = [...files.values()]
      .flatMap((file) =>
        file.references.map((reference) => {
          const candidates = definitions.get(reference.name);
          const definition = candidates?.length === 1 ? candidates[0] : undefined;
          return definition ? { ...reference, symbolId: definition.id } : reference;
        }),
      )
      .sort(compareLocated);
    const referencesByPath = new Map<string, CodeReference[]>();
    for (const reference of references) {
      const grouped = referencesByPath.get(reference.location.path) ?? [];
      grouped.push(reference);
      referencesByPath.set(reference.location.path, grouped);
    }
    const dependenciesByPath = new Map<string, typeof dependencies>();
    for (const dependency of dependencies) {
      const grouped = dependenciesByPath.get(dependency.from) ?? [];
      grouped.push(dependency);
      dependenciesByPath.set(dependency.from, grouped);
    }
    for (const file of files.values()) {
      file.references = referencesByPath.get(file.path) ?? [];
      file.dependencies = dependenciesByPath.get(file.path) ?? [];
    }
    const snapshot: RepositorySnapshot = {
      generation: `${Date.now()}-${randomUUID()}`,
      rootDigest: this.rootDigest,
      parserDigest: PARSER_DIGEST,
      configDigest: this.configDigest,
      createdAt: new Date().toISOString(),
      files,
      symbols,
      references,
      dependencies,
      facts: analysis.facts,
    };
    let persistentFailure = false;
    if (this.store) {
      try {
        await this.store.save(snapshot);
      } catch {
        persistentFailure = true;
        this.addWarning(
          'Persistent index cache could not be saved; this process uses memory only.',
        );
      }
    }
    this.snapshot = snapshot;
    this.discoveredFiles = discovery.files.length;
    this.discoveryTruncated = discovery.truncated;
    for (const path of dirtyAbsoluteAtStart) this.dirtyAbsolute.delete(path);
    this.updateTruncationWarning();
    const failed = [...files.values()].filter((file) => file.parseStatus === 'failed').length;
    this.warnings = this.warnings.filter(
      (warning) => !/^\d+ supported file\(s\) could not be parsed\.$/.test(warning),
    );
    if (failed > 0) this.addWarning(`${failed} supported file(s) could not be parsed.`);
    this.state = persistentFailure || failed > 0 || this.warnings.length > 0 ? 'degraded' : 'ready';
    this.log.info(
      {
        projectId: this.store?.projectId ?? 'memory',
        files: files.size,
        symbols: symbols.length,
        references: references.length,
        dependencies: dependencies.length,
        failed,
        ms: Date.now() - started,
      },
      'codebase index generation ready',
    );
  }

  private async indexFile(
    file: DiscoveredFile,
    previous: IndexedFile | undefined,
    dirty: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<IndexedFile> {
    throwIfAborted(signal);
    if (!file.language || !file.grammar) {
      return metadataOnly(file, 'unsupported');
    }
    if (file.size > this.options.maxFileBytes) return metadataOnly(file, 'too-large');
    const unchanged =
      this.options.refresh === 'incremental' &&
      previous?.language === file.language &&
      previous.parseStatus !== 'unsupported' &&
      previous.size === file.size &&
      previous.mtimeMs === file.mtimeMs &&
      !dirty.has(file.path);
    if (unchanged) return previous;
    let raw: Buffer;
    try {
      raw = await readFile(file.absolute);
    } catch (error) {
      return metadataOnly(file, 'failed', errorName(error));
    }
    throwIfAborted(signal);
    if (raw.includes(0)) return metadataOnly(file, 'binary');
    const contentHash = createHash('sha256').update(raw).digest('hex');
    if (
      this.options.refresh === 'incremental' &&
      previous?.contentHash === contentHash &&
      previous.language === file.language
    ) {
      return { ...previous, size: file.size, mtimeMs: file.mtimeMs };
    }
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return metadataOnly(file, 'binary');
    }
    try {
      const parsed = await parseSource({
        path: file.path,
        source,
        grammar: file.grammar,
        signal,
      });
      return {
        path: file.path,
        language: file.language,
        size: file.size,
        mtimeMs: file.mtimeMs,
        contentHash,
        parseStatus: 'ok',
        ...(parsed.hasError ? { error: 'tree-sitter recovered from syntax errors' } : {}),
        symbols: parsed.symbols,
        references: parsed.references,
        dependencies: parsed.dependencies,
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      return metadataOnly(file, 'failed', errorName(error), contentHash);
    }
  }

  private dirtyPaths(): Set<string> {
    const paths = new Set<string>();
    if (!this.root) return paths;
    for (const absolute of this.dirtyAbsolute) {
      const path = relativeRepositoryPath(this.root, absolute);
      if (path && !path.startsWith('../') && path !== '..') {
        paths.add(path);
      } else {
        this.dirtyAbsolute.delete(absolute);
      }
    }
    return paths;
  }

  private addWarning(warning: string): void {
    if (!this.warnings.includes(warning)) this.warnings.push(warning);
  }

  private updateTruncationWarning(): void {
    const warning = `File discovery reached the configured ${this.options.maxFiles}-file limit.`;
    this.warnings = this.warnings.filter((candidate) => candidate !== warning);
    if (this.discoveryTruncated) this.warnings.push(warning);
  }
}

export function createCodebaseService(
  cwd: string,
  config: CodebaseConfig | undefined,
  logger: Logger,
  options?: CodebaseServiceOptions,
): CodebaseService | undefined {
  const resolved = resolveCodebaseOptions(config);
  return resolved.enabled ? new CodebaseService(cwd, config, logger, options) : undefined;
}

export function resolveCodebaseOptions(
  config: CodebaseConfig | undefined,
): ResolvedCodebaseOptions {
  return {
    enabled: config?.enabled ?? true,
    languages: [...(config?.languages ?? DEFAULT_LANGUAGES)],
    cache: config?.cache ?? 'global',
    refresh: config?.refresh ?? 'incremental',
    maxFiles: config?.maxFiles ?? 50_000,
    maxFileBytes: config?.maxFileBytes ?? 2 * 1024 * 1024,
    parseConcurrency: config?.parseConcurrency ?? 4,
    overviewTokens: config?.overviewTokens ?? 1800,
    ignore: [...(config?.ignore ?? [])],
  };
}

function needsBuild(
  snapshot: RepositorySnapshot,
  discovery: DiscoveryResult,
  dirty: ReadonlySet<string>,
  refresh: ResolvedCodebaseOptions['refresh'],
): boolean {
  if (snapshot.generation === 'none' || refresh === 'full' || dirty.size > 0) return true;
  if (snapshot.files.size !== discovery.files.length) return true;
  for (const file of discovery.files) {
    const cached = snapshot.files.get(file.path);
    if (!cached || cached.size !== file.size || cached.mtimeMs !== file.mtimeMs) return true;
  }
  return false;
}

function structuralFiles(
  files: readonly DiscoveredFile[],
  maxFileBytes: number,
): Map<string, IndexedFile> {
  return new Map(
    files.map((file) => [
      file.path,
      !file.language
        ? metadataOnly(file, 'unsupported')
        : file.size > maxFileBytes
          ? metadataOnly(file, 'too-large')
          : metadataOnly(file, 'unsupported'),
    ]),
  );
}

function metadataOnly(
  file: DiscoveredFile,
  parseStatus: IndexedFile['parseStatus'],
  error?: string,
  contentHash?: string,
): IndexedFile {
  return {
    path: file.path,
    ...(file.language ? { language: file.language } : {}),
    size: file.size,
    mtimeMs: file.mtimeMs,
    ...(contentHash ? { contentHash } : {}),
    parseStatus,
    ...(error ? { error } : {}),
    symbols: [],
    references: [],
    dependencies: [],
  };
}

function emptySnapshot(): RepositorySnapshot {
  return {
    generation: 'none',
    rootDigest: '',
    parserDigest: PARSER_DIGEST,
    configDigest: '',
    createdAt: new Date(0).toISOString(),
    files: new Map(),
    symbols: [],
    references: [],
    dependencies: [],
    facts: {
      stacks: [],
      manifests: [],
      workspaces: [],
      entrypoints: [],
      commands: [],
      topLevelModules: [],
    },
  };
}

function digestConfig(options: ResolvedCodebaseOptions): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        languages: [...options.languages].sort(),
        refresh: options.refresh,
        maxFiles: options.maxFiles,
        maxFileBytes: options.maxFileBytes,
        ignore: [...options.ignore].sort(),
      }),
    )
    .digest('hex');
}

function normalizeQueryPath(path: string): string {
  if (!path || path.includes('\0') || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new CodebaseIndexError(`Invalid workspace-relative path: ${path}`, 'invalid_path');
  }
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized.split('/').some((part) => part === '..')) {
    throw new CodebaseIndexError(`Path escapes the workspace: ${path}`, 'invalid_path');
  }
  return normalized || '.';
}

function pathMatches(candidate: string, filter: string | undefined): boolean {
  if (!filter || filter === '.') return true;
  return candidate === filter || candidate.startsWith(`${filter}/`);
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return Math.min(200, Math.max(1, value ?? fallback));
}

function queryDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function encodeCursor(generation: string, query: string, offset: number): string {
  return Buffer.from(JSON.stringify({ generation, query, offset })).toString('base64url');
}

function decodeCursor(cursor: string | undefined, generation: string, query: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      generation?: unknown;
      query?: unknown;
      offset?: unknown;
    };
    if (
      parsed.generation !== generation ||
      parsed.query !== query ||
      typeof parsed.offset !== 'number' ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new Error('stale');
    }
    return parsed.offset;
  } catch {
    throw new CodebaseIndexError(
      'The codebase result cursor is stale or invalid; repeat the query without cursor.',
      'cursor_stale',
    );
  }
}

function definitionRank(
  symbol: CodeSymbol,
  fromPath: string | undefined,
  directTargets: ReadonlySet<string>,
): number {
  if (symbol.location.path === fromPath) return 0;
  if (directTargets.has(symbol.location.path)) return 1;
  return 2;
}

function compareSymbol(left: CodeSymbol, right: CodeSymbol): number {
  return (
    left.location.path.localeCompare(right.location.path) ||
    left.location.start.line - right.location.start.line ||
    left.location.start.column - right.location.start.column ||
    left.name.localeCompare(right.name)
  );
}

function compareLocated(
  left: CodeReference | CodeSymbol,
  right: CodeReference | CodeSymbol,
): number {
  return (
    left.location.path.localeCompare(right.location.path) ||
    left.location.start.line - right.location.start.line ||
    left.location.start.column - right.location.start.column
  );
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
  signal: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, values.length)) },
    async () => {
      while (true) {
        throwIfAborted(signal);
        const index = cursor++;
        const value = values[index];
        if (value === undefined) return;
        results[index] = await map(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function requiredSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal;
}

async function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
