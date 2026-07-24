import type { CodebaseLanguage } from '../config/schema.js';

export type IndexState = 'empty' | 'building' | 'ready' | 'stale' | 'degraded';
export type SymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'variable'
  | 'constant'
  | 'module'
  | 'namespace'
  | 'unknown';
export type ReferenceKind = 'read' | 'write' | 'call' | 'import' | 'unknown';
export type Confidence = 'exact' | 'syntactic' | 'heuristic';

export interface SourcePoint {
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

export interface SourceLocation {
  /** Workspace-relative POSIX path. */
  path: string;
  start: SourcePoint;
  end: SourcePoint;
}

export interface CodeSymbol {
  id: string;
  name: string;
  qualifiedName?: string;
  kind: SymbolKind;
  language: CodebaseLanguage;
  location: SourceLocation;
  signature?: string;
  exported: boolean;
  containerId?: string;
}

export interface CodeReference {
  symbolId?: string;
  name: string;
  kind: ReferenceKind;
  location: SourceLocation;
  confidence: Confidence;
}

export type DependencyKind = 'import' | 'export' | 'require' | 'workspace' | 'manifest';

export interface DependencyEdge {
  from: string;
  to?: string;
  specifier: string;
  kind: DependencyKind;
  confidence: Confidence;
}

export type ParseStatus = 'ok' | 'unsupported' | 'too-large' | 'binary' | 'failed';

export interface IndexedFile {
  path: string;
  language?: CodebaseLanguage;
  size: number;
  mtimeMs: number;
  contentHash?: string;
  parseStatus: ParseStatus;
  error?: string;
  symbols: CodeSymbol[];
  references: CodeReference[];
  dependencies: DependencyEdge[];
}

export interface RepositoryFacts {
  stacks: string[];
  manifests: string[];
  workspaces: string[];
  entrypoints: string[];
  commands: Array<{ name: string; command: string }>;
  topLevelModules: string[];
}

export interface RepositorySnapshot {
  generation: string;
  rootDigest: string;
  parserDigest: string;
  configDigest: string;
  createdAt: string;
  files: Map<string, IndexedFile>;
  symbols: CodeSymbol[];
  references: CodeReference[];
  dependencies: DependencyEdge[];
  facts: RepositoryFacts;
}

export interface IndexStatus {
  state: IndexState;
  generation: string;
  indexedFiles: number;
  discoveredFiles: number;
  supportedFiles: number;
  failedFiles: number;
  staleFiles: number;
  coverage: number;
  warnings: string[];
}

export interface SymbolQuery {
  path?: string;
  name?: string;
  kind?: SymbolKind;
  limit?: number;
  cursor?: string;
}

export interface DefinitionQuery {
  name: string;
  fromPath?: string;
  limit?: number;
}

export interface ReferenceQuery {
  name: string;
  path?: string;
  includeDeclaration?: boolean;
  limit?: number;
  cursor?: string;
}

export interface DependencyQuery {
  path: string;
  direction?: 'incoming' | 'outgoing' | 'both';
  depth?: number;
  limit?: number;
}

export interface ResultPage<T> {
  items: T[];
  nextCursor?: string;
  truncated: boolean;
  status: IndexStatus;
}

export interface DependencyResult {
  edges: DependencyEdge[];
  truncated: boolean;
  status: IndexStatus;
}

export interface RepositoryOverview {
  version: string;
  content: string;
  status: IndexStatus;
}

export interface ParsedFile {
  symbols: CodeSymbol[];
  references: CodeReference[];
  dependencies: DependencyEdge[];
  hasError: boolean;
}

export interface DiscoveredFile {
  path: string;
  absolute: string;
  size: number;
  mtimeMs: number;
  language?: CodebaseLanguage;
  grammar?: 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'rust';
}
