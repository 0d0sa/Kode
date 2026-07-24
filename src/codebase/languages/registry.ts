import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Language, Parser, type Node as SyntaxNode, type Tree } from 'web-tree-sitter';
import type { CodebaseLanguage } from '../../config/schema.js';
import type {
  CodeReference,
  CodeSymbol,
  DependencyEdge,
  DependencyKind,
  ParsedFile,
  ReferenceKind,
  SymbolKind,
} from '../types.js';

export const PARSER_DIGEST = 'web-tree-sitter@0.25.10|tree-sitter-wasms@0.1.13|kode-query-pack-v1';

type GrammarId = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'rust';

interface DeclarationRule {
  kind: SymbolKind;
  nameField?: string;
}

interface LanguageProfile {
  language: CodebaseLanguage;
  declarations: Record<string, DeclarationRule>;
  identifierTypes: string[];
}

const PROFILES: Record<GrammarId, LanguageProfile> = {
  typescript: {
    language: 'typescript',
    declarations: {
      function_declaration: { kind: 'function' },
      generator_function_declaration: { kind: 'function' },
      class_declaration: { kind: 'class' },
      interface_declaration: { kind: 'interface' },
      type_alias_declaration: { kind: 'type' },
      enum_declaration: { kind: 'enum' },
      method_definition: { kind: 'method' },
      variable_declarator: { kind: 'variable' },
      internal_module: { kind: 'namespace' },
    },
    identifierTypes: [
      'identifier',
      'property_identifier',
      'type_identifier',
      'shorthand_property_identifier',
    ],
  },
  tsx: {
    language: 'typescript',
    declarations: {
      function_declaration: { kind: 'function' },
      generator_function_declaration: { kind: 'function' },
      class_declaration: { kind: 'class' },
      interface_declaration: { kind: 'interface' },
      type_alias_declaration: { kind: 'type' },
      enum_declaration: { kind: 'enum' },
      method_definition: { kind: 'method' },
      variable_declarator: { kind: 'variable' },
    },
    identifierTypes: [
      'identifier',
      'property_identifier',
      'type_identifier',
      'shorthand_property_identifier',
    ],
  },
  javascript: {
    language: 'javascript',
    declarations: {
      function_declaration: { kind: 'function' },
      generator_function_declaration: { kind: 'function' },
      class_declaration: { kind: 'class' },
      method_definition: { kind: 'method' },
      variable_declarator: { kind: 'variable' },
    },
    identifierTypes: ['identifier', 'property_identifier', 'shorthand_property_identifier'],
  },
  python: {
    language: 'python',
    declarations: {
      function_definition: { kind: 'function' },
      class_definition: { kind: 'class' },
      assignment: { kind: 'variable', nameField: 'left' },
    },
    identifierTypes: ['identifier'],
  },
  go: {
    language: 'go',
    declarations: {
      function_declaration: { kind: 'function' },
      method_declaration: { kind: 'method' },
      type_spec: { kind: 'type' },
      const_spec: { kind: 'constant' },
      var_spec: { kind: 'variable' },
    },
    identifierTypes: ['identifier', 'field_identifier', 'type_identifier', 'package_identifier'],
  },
  rust: {
    language: 'rust',
    declarations: {
      function_item: { kind: 'function' },
      struct_item: { kind: 'class' },
      enum_item: { kind: 'enum' },
      trait_item: { kind: 'interface' },
      type_item: { kind: 'type' },
      const_item: { kind: 'constant' },
      static_item: { kind: 'variable' },
      mod_item: { kind: 'module' },
    },
    identifierTypes: ['identifier', 'field_identifier', 'type_identifier'],
  },
};

const require = createRequire(import.meta.url);
let parserInitialization: Promise<void> | undefined;
const languages = new Map<GrammarId, Promise<Language>>();

export interface ParseSourceOptions {
  path: string;
  source: string;
  grammar: GrammarId;
  signal: AbortSignal;
}

export async function parseSource(options: ParseSourceOptions): Promise<ParsedFile> {
  throwIfAborted(options.signal);
  await initializeParser();
  const language = await loadLanguage(options.grammar);
  throwIfAborted(options.signal);
  const parser = new Parser();
  parser.setLanguage(language);
  let tree: Tree | null = null;
  try {
    tree = parser.parse(options.source, null, {
      progressCallback: () => options.signal.aborted,
    });
    if (!tree) throw new DOMException('Aborted', 'AbortError');
    const profile = PROFILES[options.grammar];
    const symbols = extractSymbols(tree.rootNode, options.path, options.source, profile);
    const references = extractReferences(
      tree.rootNode,
      options.path,
      profile,
      new Set(
        symbols.map(
          (symbol) =>
            `${symbol.location.start.line}:${symbol.location.start.column}:${symbol.name}`,
        ),
      ),
    );
    return {
      symbols,
      references,
      dependencies: extractDependencies(options.path, options.source, profile.language),
      hasError: tree.rootNode.hasError,
    };
  } finally {
    tree?.delete();
    parser.delete();
  }
}

function initializeParser(): Promise<void> {
  parserInitialization ??= Parser.init();
  return parserInitialization;
}

function loadLanguage(grammar: GrammarId): Promise<Language> {
  const existing = languages.get(grammar);
  if (existing) return existing;
  const path = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
  const pending = Language.load(path);
  languages.set(grammar, pending);
  return pending;
}

function extractSymbols(
  root: SyntaxNode,
  path: string,
  source: string,
  profile: LanguageProfile,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  visit(root, (node) => {
    const rule = profile.declarations[node.type];
    if (!rule) return;
    const nameNode = node.childForFieldName(rule.nameField ?? 'name') ?? fallbackNameNode(node);
    if (!nameNode) return;
    const name = nameNode.text.trim();
    if (!isIdentifier(name)) return;
    const kind = declarationKind(node, rule.kind, profile.language);
    const location = locationFor(path, nameNode);
    const container = enclosingDeclaration(node.parent, profile);
    const qualifiedName = container ? `${container}.${name}` : undefined;
    symbols.push({
      id: createHash('sha256')
        .update(`${path}:${location.start.line}:${location.start.column}:${kind}:${name}`)
        .digest('hex')
        .slice(0, 24),
      name,
      ...(qualifiedName ? { qualifiedName } : {}),
      kind,
      language: profile.language,
      location,
      signature: signatureFor(node, source),
      exported: isExported(node),
    });
  });
  return symbols.sort(compareLocation);
}

function extractReferences(
  root: SyntaxNode,
  path: string,
  profile: LanguageProfile,
  definitions: ReadonlySet<string>,
): CodeReference[] {
  const references: CodeReference[] = [];
  const candidates = root.descendantsOfType(profile.identifierTypes);
  for (const node of candidates) {
    if (!node) continue;
    const name = node.text.trim();
    if (!isIdentifier(name)) continue;
    const location = locationFor(path, node);
    const definitionKey = `${location.start.line}:${location.start.column}:${name}`;
    if (definitions.has(definitionKey)) continue;
    references.push({
      name,
      kind: referenceKind(node),
      location,
      confidence: 'syntactic',
    });
  }
  return references.sort(compareLocation);
}

function extractDependencies(
  path: string,
  source: string,
  language: CodebaseLanguage,
): DependencyEdge[] {
  const found: Array<{ specifier: string; kind: DependencyKind }> = [];
  if (language === 'typescript' || language === 'javascript') {
    collectMatches(
      source,
      /\b(import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
      (match) => ({
        specifier: match[2] ?? '',
        kind: match[1] === 'export' ? 'export' : 'import',
      }),
      found,
    );
    collectMatches(
      source,
      /\b(require|import)\s*\(\s*["']([^"']+)["']\s*\)/g,
      (match) => ({
        specifier: match[2] ?? '',
        kind: match[1] === 'require' ? 'require' : 'import',
      }),
      found,
    );
  } else if (language === 'python') {
    collectMatches(
      source,
      /^\s*from\s+([.\w]+)\s+import\b/gm,
      (match) => ({
        specifier: match[1] ?? '',
        kind: 'import',
      }),
      found,
    );
    collectMatches(
      source,
      /^\s*import\s+([.\w]+)/gm,
      (match) => ({
        specifier: match[1] ?? '',
        kind: 'import',
      }),
      found,
    );
  } else if (language === 'go') {
    collectMatches(
      source,
      /^\s*(?:import\s+)?(?:[\w.]+\s+)?["']([^"']+)["']/gm,
      (match) => ({
        specifier: match[1] ?? '',
        kind: 'import',
      }),
      found,
    );
  } else if (language === 'rust') {
    collectMatches(
      source,
      /^\s*use\s+([^;]+);/gm,
      (match) => ({
        specifier: (match[1] ?? '').trim(),
        kind: 'import',
      }),
      found,
    );
    collectMatches(
      source,
      /^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm,
      (match) => ({
        specifier: match[1] ?? '',
        kind: 'import',
      }),
      found,
    );
  }
  const seen = new Set<string>();
  return found
    .filter(({ specifier }) => specifier && !seen.has(specifier) && Boolean(seen.add(specifier)))
    .map(({ specifier, kind }) => ({
      from: path,
      specifier,
      kind,
      confidence: 'syntactic',
    }));
}

function collectMatches(
  source: string,
  expression: RegExp,
  map: (match: RegExpExecArray) => { specifier: string; kind: DependencyKind },
  output: Array<{ specifier: string; kind: DependencyKind }>,
): void {
  expression.lastIndex = 0;
  let match = expression.exec(source);
  while (match) {
    output.push(map(match));
    match = expression.exec(source);
  }
}

function fallbackNameNode(node: SyntaxNode): SyntaxNode | null {
  return (
    node.namedChildren.find(
      (child): child is SyntaxNode =>
        child !== null &&
        ['identifier', 'property_identifier', 'type_identifier', 'field_identifier'].includes(
          child.type,
        ),
    ) ?? null
  );
}

function declarationKind(
  node: SyntaxNode,
  fallback: SymbolKind,
  language: CodebaseLanguage,
): SymbolKind {
  if (
    fallback === 'function' &&
    ((language === 'python' &&
      hasAncestorBefore(node.parent, 'class_definition', 'function_definition')) ||
      (language === 'rust' && hasAncestorBefore(node.parent, 'impl_item', 'function_item')))
  ) {
    return 'method';
  }
  if (fallback !== 'variable') return fallback;
  const value = node.childForFieldName('value');
  if (value && ['arrow_function', 'function_expression'].includes(value.type)) return 'function';
  const parentText = node.parent?.text.slice(0, 24) ?? '';
  return /^\s*const\b/.test(parentText) ? 'constant' : fallback;
}

function hasAncestorBefore(
  node: SyntaxNode | null,
  ancestorType: string,
  boundaryType: string,
): boolean {
  let current = node;
  for (let depth = 0; current && depth < 12; depth++, current = current.parent) {
    if (current.type === ancestorType) return true;
    if (current.type === boundaryType) return false;
  }
  return false;
}

function enclosingDeclaration(
  node: SyntaxNode | null,
  profile: LanguageProfile,
): string | undefined {
  let current = node;
  for (let depth = 0; current && depth < 8; depth++, current = current.parent) {
    if (!profile.declarations[current.type]) continue;
    const name = current.childForFieldName('name')?.text.trim();
    if (name && isIdentifier(name)) return name;
  }
  return undefined;
}

function isExported(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node;
  for (let depth = 0; current && depth < 4; depth++, current = current.parent) {
    if (current.type === 'export_statement') return true;
    if (/^\s*pub(?:\(|\s)/.test(current.text)) return true;
  }
  return false;
}

function referenceKind(node: SyntaxNode): ReferenceKind {
  let current: SyntaxNode | null = node;
  for (let depth = 0; current && depth < 5; depth++, current = current.parent) {
    if (
      [
        'import_statement',
        'import_declaration',
        'export_statement',
        'use_declaration',
        'use_list',
      ].includes(current.type)
    ) {
      return 'import';
    }
    if (
      [
        'call',
        'call_expression',
        'new_expression',
        'await_expression',
        'macro_invocation',
      ].includes(current.type)
    ) {
      return 'call';
    }
    if (
      ['assignment_expression', 'assignment', 'augmented_assignment', 'left_hand_side'].includes(
        current.type,
      )
    ) {
      return 'write';
    }
  }
  return 'read';
}

function signatureFor(node: SyntaxNode, source: string): string {
  const raw = source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 500));
  const firstBody = raw.search(/[{:]\s*(?:\r?\n|$)/);
  const candidate = (firstBody > 0 ? raw.slice(0, firstBody) : (raw.split(/\r?\n/, 1)[0] ?? raw))
    .replace(/\s+/g, ' ')
    .trim();
  return candidate.slice(0, 240);
}

function locationFor(path: string, node: SyntaxNode) {
  return {
    path,
    start: { line: node.startPosition.row + 1, column: node.startPosition.column + 1 },
    end: { line: node.endPosition.row + 1, column: node.endPosition.column + 1 },
  };
}

function compareLocation(
  left: { location: { path: string; start: { line: number; column: number } } },
  right: { location: { path: string; start: { line: number; column: number } } },
): number {
  return (
    left.location.path.localeCompare(right.location.path) ||
    left.location.start.line - right.location.start.line ||
    left.location.start.column - right.location.start.column
  );
}

function visit(node: SyntaxNode, callback: (node: SyntaxNode) => void): void {
  callback(node);
  for (const child of node.namedChildren) {
    if (child) visit(child, callback);
  }
}

function isIdentifier(value: string): boolean {
  return value.length <= 200 && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}
