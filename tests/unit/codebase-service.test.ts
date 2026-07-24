import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodebaseIndexError } from '../../src/codebase/errors.js';
import { CodebaseService } from '../../src/codebase/service.js';
import { createDefaultRegistry } from '../../src/tools/index.js';
import { testLogger } from './helpers.js';

let temporary: string;
let project: string;
let cache: string;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'kode-codebase-test-'));
  project = join(temporary, 'project');
  cache = join(temporary, 'cache');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      scripts: { test: 'vitest run' },
      main: './src/index.ts',
    }),
  );
  writeFileSync(
    join(project, 'src', 'index.ts'),
    "import { helper } from './helper.js';\nexport function handleError(error: Error) { return helper(error) }\nhandleError(new Error('x'));\n",
  );
  writeFileSync(
    join(project, 'src', 'helper.ts'),
    'export function helper<T>(value: T): T { return value }\n',
  );
});

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});

function service(): CodebaseService {
  return new CodebaseService(
    project,
    {
      cache: 'global',
      languages: ['typescript', 'javascript', 'python', 'go', 'rust'],
      overviewTokens: 500,
    },
    testLogger,
    { cacheRoot: cache },
  );
}

describe('CodebaseService', () => {
  it('indexes definitions, references, dependencies, overview, and reloads the cache', async () => {
    const first = service();
    const status = await first.reconcile();
    expect(status).toMatchObject({ state: 'ready', indexedFiles: 2, coverage: 1 });

    const definitions = await first.findDefinitions({
      name: 'handleError',
      fromPath: 'src/index.ts',
    });
    expect(definitions.items[0]?.location.path).toBe('src/index.ts');

    const references = await first.findReferences({
      name: 'handleError',
      includeDeclaration: true,
    });
    expect(references.items).toHaveLength(2);

    const dependencies = await first.dependencies({
      path: 'src/index.ts',
      direction: 'outgoing',
    });
    expect(dependencies.edges).toContainEqual(
      expect.objectContaining({ from: 'src/index.ts', to: 'src/helper.ts' }),
    );

    const overview = await first.overview();
    expect(overview.content).toContain('TypeScript');
    expect(overview.content).toContain('test: vitest run');
    const generation = status.generation;
    await first.close();

    const second = service();
    await second.start();
    expect(second.status().generation).toBe(generation);
    await second.reconcile();
    expect(second.status().generation).toBe(generation);
    await second.close();
  });

  it('invalidates a dirty file and rejects cursors from an older generation', async () => {
    const index = service();
    await index.reconcile();
    const page = await index.listSymbols({ limit: 1 });
    expect(page.nextCursor).toBeDefined();

    const helper = join(project, 'src', 'helper.ts');
    writeFileSync(
      helper,
      'export function helper<T>(value: T): T { return value }\nexport function added() { return 1 }\n',
    );
    index.markDirty([helper]);
    expect(index.status().state).toBe('stale');
    await index.reconcile();
    expect((await index.findDefinitions({ name: 'added' })).items).toHaveLength(1);
    await expect(index.listSymbols({ limit: 1, cursor: page.nextCursor })).rejects.toBeInstanceOf(
      CodebaseIndexError,
    );
    await index.close();
  });

  it('registers all four read-only codebase tools', async () => {
    const index = service();
    const registry = createDefaultRegistry({}, { codebase: index });
    expect(registry.specs().map((spec) => spec.name)).toEqual(
      expect.arrayContaining([
        'list_symbols',
        'find_definition',
        'find_references',
        'module_dependencies',
      ]),
    );
    await index.close();
  });
});
