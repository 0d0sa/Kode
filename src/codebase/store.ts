import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type {
  CodeReference,
  CodeSymbol,
  DependencyEdge,
  IndexedFile,
  RepositoryFacts,
  RepositorySnapshot,
} from './types.js';

const INDEX_SCHEMA_VERSION = 1;

interface IndexManifest {
  schemaVersion: number;
  projectId: string;
  rootDigest: string;
  parserDigest: string;
  configDigest: string;
  activeGeneration: string;
  generatedAt: string;
}

interface GenerationRow {
  id: string;
  root_digest: string;
  parser_digest: string;
  config_digest: string;
  created_at: string;
  facts_json: string;
}

interface FileRow {
  path: string;
  language: IndexedFile['language'] | null;
  size: number;
  mtime_ms: number;
  content_hash: string | null;
  parse_status: IndexedFile['parseStatus'];
  error: string | null;
}

interface SymbolRow {
  id: string;
  name: string;
  qualified_name: string | null;
  kind: CodeSymbol['kind'];
  language: CodeSymbol['language'];
  path: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  signature: string | null;
  exported: number;
  container_id: string | null;
}

interface ReferenceRow {
  symbol_id: string | null;
  name: string;
  kind: CodeReference['kind'];
  path: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  confidence: CodeReference['confidence'];
}

interface DependencyRow {
  from_path: string;
  to_path: string | null;
  specifier: string;
  kind: DependencyEdge['kind'];
  confidence: DependencyEdge['confidence'];
}

export interface IndexStoreOptions {
  root: string;
  rootDigest: string;
  parserDigest: string;
  configDigest: string;
  cacheRoot?: string;
}

export class SqliteIndexStore {
  readonly projectId: string;
  readonly directory: string;
  private readonly databasePath: string;
  private readonly manifestPath: string;

  constructor(private readonly options: IndexStoreOptions) {
    this.projectId = createHash('sha256').update(options.root).digest('hex').slice(0, 24);
    this.directory = join(options.cacheRoot ?? join(homedir(), '.kode', 'index'), this.projectId);
    this.databasePath = join(this.directory, 'index.sqlite');
    this.manifestPath = join(this.directory, 'manifest.json');
  }

  async load(): Promise<RepositorySnapshot | null> {
    const manifest = await readManifest(this.manifestPath);
    if (!manifest || !this.isCompatible(manifest)) return null;
    let database: Database.Database | undefined;
    try {
      database = new Database(this.databasePath, { readonly: true, fileMustExist: true });
      const generation = database
        .prepare('SELECT * FROM generations WHERE id = ?')
        .get(manifest.activeGeneration) as GenerationRow | undefined;
      if (!generation || !this.generationCompatible(generation)) return null;
      const files = new Map<string, IndexedFile>();
      for (const row of database
        .prepare('SELECT * FROM files WHERE generation = ? ORDER BY path')
        .all(generation.id) as FileRow[]) {
        files.set(row.path, {
          path: row.path,
          ...(row.language ? { language: row.language } : {}),
          size: row.size,
          mtimeMs: row.mtime_ms,
          ...(row.content_hash ? { contentHash: row.content_hash } : {}),
          parseStatus: row.parse_status,
          ...(row.error ? { error: row.error } : {}),
          symbols: [],
          references: [],
          dependencies: [],
        });
      }
      const symbols = (
        database
          .prepare(
            'SELECT * FROM symbols WHERE generation = ? ORDER BY path, start_line, start_column',
          )
          .all(generation.id) as SymbolRow[]
      ).map(fromSymbolRow);
      const references = (
        database
          .prepare(
            'SELECT * FROM refs WHERE generation = ? ORDER BY path, start_line, start_column',
          )
          .all(generation.id) as ReferenceRow[]
      ).map(fromReferenceRow);
      const dependencies = (
        database
          .prepare('SELECT * FROM dependencies WHERE generation = ? ORDER BY from_path, specifier')
          .all(generation.id) as DependencyRow[]
      ).map(fromDependencyRow);
      attachRows(files, symbols, references, dependencies);
      return {
        generation: generation.id,
        rootDigest: generation.root_digest,
        parserDigest: generation.parser_digest,
        configDigest: generation.config_digest,
        createdAt: generation.created_at,
        files,
        symbols,
        references,
        dependencies,
        facts: JSON.parse(generation.facts_json) as RepositoryFacts,
      };
    } finally {
      database?.close();
    }
  }

  async save(snapshot: RepositorySnapshot): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => undefined);
    const database = new Database(this.databasePath);
    try {
      initializeSchema(database);
      database.pragma('journal_mode = WAL');
      const commit = database.transaction(() => {
        insertSnapshot(database as Database.Database, snapshot);
        database.prepare('DELETE FROM generations WHERE id <> ?').run(snapshot.generation);
        database.prepare('DELETE FROM files WHERE generation <> ?').run(snapshot.generation);
        database.prepare('DELETE FROM symbols WHERE generation <> ?').run(snapshot.generation);
        database.prepare('DELETE FROM refs WHERE generation <> ?').run(snapshot.generation);
        database.prepare('DELETE FROM dependencies WHERE generation <> ?').run(snapshot.generation);
      });
      commit();
    } finally {
      database.close();
    }
    await chmod(this.databasePath, 0o600).catch(() => undefined);
    const manifest: IndexManifest = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      projectId: this.projectId,
      rootDigest: snapshot.rootDigest,
      parserDigest: snapshot.parserDigest,
      configDigest: snapshot.configDigest,
      activeGeneration: snapshot.generation,
      generatedAt: snapshot.createdAt,
    };
    const temporary = `${this.manifestPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.manifestPath);
  }

  private isCompatible(manifest: IndexManifest): boolean {
    return (
      manifest.schemaVersion === INDEX_SCHEMA_VERSION &&
      manifest.projectId === this.projectId &&
      manifest.rootDigest === this.options.rootDigest &&
      manifest.parserDigest === this.options.parserDigest &&
      manifest.configDigest === this.options.configDigest
    );
  }

  private generationCompatible(generation: GenerationRow): boolean {
    return (
      generation.root_digest === this.options.rootDigest &&
      generation.parser_digest === this.options.parserDigest &&
      generation.config_digest === this.options.configDigest
    );
  }
}

function initializeSchema(database: Database.Database): void {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      root_digest TEXT NOT NULL,
      parser_digest TEXT NOT NULL,
      config_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      facts_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      generation TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      content_hash TEXT,
      parse_status TEXT NOT NULL,
      error TEXT,
      PRIMARY KEY (generation, path)
    );
    CREATE TABLE IF NOT EXISTS symbols (
      generation TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT,
      kind TEXT NOT NULL,
      language TEXT NOT NULL,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      signature TEXT,
      exported INTEGER NOT NULL,
      container_id TEXT,
      PRIMARY KEY (generation, id)
    );
    CREATE INDEX IF NOT EXISTS symbols_name ON symbols(generation, name);
    CREATE TABLE IF NOT EXISTS refs (
      generation TEXT NOT NULL,
      symbol_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      confidence TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS refs_name ON refs(generation, name);
    CREATE TABLE IF NOT EXISTS dependencies (
      generation TEXT NOT NULL,
      from_path TEXT NOT NULL,
      to_path TEXT,
      specifier TEXT NOT NULL,
      kind TEXT NOT NULL,
      confidence TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deps_from ON dependencies(generation, from_path);
    CREATE INDEX IF NOT EXISTS deps_to ON dependencies(generation, to_path);
  `);
}

function insertSnapshot(database: Database.Database, snapshot: RepositorySnapshot): void {
  database
    .prepare(
      `INSERT OR REPLACE INTO generations
       (id, root_digest, parser_digest, config_digest, created_at, facts_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      snapshot.generation,
      snapshot.rootDigest,
      snapshot.parserDigest,
      snapshot.configDigest,
      snapshot.createdAt,
      JSON.stringify(snapshot.facts),
    );
  const fileStatement = database.prepare(
    `INSERT INTO files
     (generation, path, language, size, mtime_ms, content_hash, parse_status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const symbolStatement = database.prepare(
    `INSERT INTO symbols
     (generation, id, name, qualified_name, kind, language, path, start_line, start_column,
      end_line, end_column, signature, exported, container_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const referenceStatement = database.prepare(
    `INSERT INTO refs
     (generation, symbol_id, name, kind, path, start_line, start_column, end_line, end_column,
      confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const dependencyStatement = database.prepare(
    `INSERT INTO dependencies
     (generation, from_path, to_path, specifier, kind, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const file of snapshot.files.values()) {
    fileStatement.run(
      snapshot.generation,
      file.path,
      file.language ?? null,
      file.size,
      file.mtimeMs,
      file.contentHash ?? null,
      file.parseStatus,
      file.error ?? null,
    );
  }
  for (const symbol of snapshot.symbols) {
    symbolStatement.run(
      snapshot.generation,
      symbol.id,
      symbol.name,
      symbol.qualifiedName ?? null,
      symbol.kind,
      symbol.language,
      symbol.location.path,
      symbol.location.start.line,
      symbol.location.start.column,
      symbol.location.end.line,
      symbol.location.end.column,
      symbol.signature ?? null,
      symbol.exported ? 1 : 0,
      symbol.containerId ?? null,
    );
  }
  for (const reference of snapshot.references) {
    referenceStatement.run(
      snapshot.generation,
      reference.symbolId ?? null,
      reference.name,
      reference.kind,
      reference.location.path,
      reference.location.start.line,
      reference.location.start.column,
      reference.location.end.line,
      reference.location.end.column,
      reference.confidence,
    );
  }
  for (const dependency of snapshot.dependencies) {
    dependencyStatement.run(
      snapshot.generation,
      dependency.from,
      dependency.to ?? null,
      dependency.specifier,
      dependency.kind,
      dependency.confidence,
    );
  }
}

function attachRows(
  files: Map<string, IndexedFile>,
  symbols: readonly CodeSymbol[],
  references: readonly CodeReference[],
  dependencies: readonly DependencyEdge[],
): void {
  for (const symbol of symbols) files.get(symbol.location.path)?.symbols.push(symbol);
  for (const reference of references)
    files.get(reference.location.path)?.references.push(reference);
  for (const dependency of dependencies) files.get(dependency.from)?.dependencies.push(dependency);
}

function fromSymbolRow(row: SymbolRow): CodeSymbol {
  return {
    id: row.id,
    name: row.name,
    ...(row.qualified_name ? { qualifiedName: row.qualified_name } : {}),
    kind: row.kind,
    language: row.language,
    location: {
      path: row.path,
      start: { line: row.start_line, column: row.start_column },
      end: { line: row.end_line, column: row.end_column },
    },
    ...(row.signature ? { signature: row.signature } : {}),
    exported: Boolean(row.exported),
    ...(row.container_id ? { containerId: row.container_id } : {}),
  };
}

function fromReferenceRow(row: ReferenceRow): CodeReference {
  return {
    ...(row.symbol_id ? { symbolId: row.symbol_id } : {}),
    name: row.name,
    kind: row.kind,
    location: {
      path: row.path,
      start: { line: row.start_line, column: row.start_column },
      end: { line: row.end_line, column: row.end_column },
    },
    confidence: row.confidence,
  };
}

function fromDependencyRow(row: DependencyRow): DependencyEdge {
  return {
    from: row.from_path,
    ...(row.to_path ? { to: row.to_path } : {}),
    specifier: row.specifier,
    kind: row.kind,
    confidence: row.confidence,
  };
}

async function readManifest(path: string): Promise<IndexManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<IndexManifest>;
    if (
      typeof parsed.schemaVersion !== 'number' ||
      typeof parsed.projectId !== 'string' ||
      typeof parsed.rootDigest !== 'string' ||
      typeof parsed.parserDigest !== 'string' ||
      typeof parsed.configDigest !== 'string' ||
      typeof parsed.activeGeneration !== 'string' ||
      typeof parsed.generatedAt !== 'string'
    ) {
      return null;
    }
    return parsed as IndexManifest;
  } catch {
    return null;
  }
}
