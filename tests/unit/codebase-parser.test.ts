import { describe, expect, it } from 'vitest';
import { parseSource } from '../../src/codebase/languages/registry.js';

const signal = new AbortController().signal;

describe('tree-sitter language registry', () => {
  it.each([
    {
      grammar: 'typescript' as const,
      path: 'src/a.ts',
      source:
        "import { helper } from './helper.js'; export function handleError(value: Error) { helper(); return value } handleError(new Error())",
      symbol: 'handleError',
      dependency: './helper.js',
    },
    {
      grammar: 'tsx' as const,
      path: 'src/view.tsx',
      source:
        "export interface Props { name: string }\nexport function View(props: Props) { return <div>{props.name}</div> }\nView({ name: 'x' })",
      symbol: 'View',
      dependency: undefined,
    },
    {
      grammar: 'javascript' as const,
      path: 'src/a.js',
      source:
        "const helper = require('./helper.js'); function handleError(value) { helper(); return value } handleError(new Error())",
      symbol: 'handleError',
      dependency: './helper.js',
    },
    {
      grammar: 'python' as const,
      path: 'a.py',
      source:
        'from helpers import log\n\ndef handle_error(value):\n    log(value)\n    return value\n\nhandle_error(Exception())\n',
      symbol: 'handle_error',
      dependency: 'helpers',
    },
    {
      grammar: 'go' as const,
      path: 'a.go',
      source:
        'package main\nimport "fmt"\nfunc HandleError(value error) error { fmt.Println(value); return value }\nfunc main() { HandleError(nil) }\n',
      symbol: 'HandleError',
      dependency: 'fmt',
    },
    {
      grammar: 'rust' as const,
      path: 'src/main.rs',
      source:
        'use crate::helper;\npub fn handle_error(value: &str) -> &str { helper::log(value); value }\nfn main() { handle_error("x"); }\n',
      symbol: 'handle_error',
      dependency: 'crate::helper',
    },
  ])('extracts symbols and calls from $grammar', async (fixture) => {
    const parsed = await parseSource({
      path: fixture.path,
      source: fixture.source,
      grammar: fixture.grammar,
      signal,
    });

    expect(parsed.symbols.some((symbol) => symbol.name === fixture.symbol)).toBe(true);
    expect(
      parsed.references.some(
        (reference) => reference.name === fixture.symbol && reference.kind === 'call',
      ),
    ).toBe(true);
    if (fixture.dependency) {
      expect(parsed.dependencies.some((edge) => edge.specifier === fixture.dependency)).toBe(true);
    }
  });

  it('normalizes language-specific methods, functions, variables, and constants', async () => {
    const typescript = await parseSource({
      path: 'symbols.ts',
      source:
        'const handler = () => 1;\nlet mutable = 2;\nclass Service { run() { return handler() } }',
      grammar: 'typescript',
      signal,
    });
    expect(typescript.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'handler', kind: 'function' }),
        expect.objectContaining({ name: 'mutable', kind: 'variable' }),
        expect.objectContaining({ name: 'run', kind: 'method' }),
      ]),
    );

    const python = await parseSource({
      path: 'symbols.py',
      source: 'VALUE = 1\nclass Service:\n    def run(self):\n        local = VALUE\n',
      grammar: 'python',
      signal,
    });
    expect(python.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'VALUE', kind: 'variable' }),
        expect.objectContaining({ name: 'run', kind: 'method' }),
        expect.objectContaining({ name: 'local', kind: 'variable' }),
      ]),
    );

    const rust = await parseSource({
      path: 'symbols.rs',
      source: 'struct Service;\nimpl Service { fn run(&self) {} }\nconst VALUE: i32 = 1;',
      grammar: 'rust',
      signal,
    });
    expect(rust.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'run', kind: 'method' }),
        expect.objectContaining({ name: 'VALUE', kind: 'constant' }),
      ]),
    );
  });
});
