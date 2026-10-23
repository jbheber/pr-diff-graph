import { beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.js';
import { goParser } from '../../../src/parsers/go.js';
import { grammarDir, initTreeSitter } from '../../../src/parsers/treesitter.js';
import type { LanguageParser, Resolution } from '../../../src/parsers/types.js';
import type { RepoIndex } from '../../../src/repo/index.js';
import { indexOf } from '../repo/helpers.js';

let parser: LanguageParser;

beforeAll(async () => {
  parser = goParser(await initTreeSitter(grammarDir()), silentLogger);
});

const resolve = (repo: RepoIndex, from: string, specifier: string): Resolution =>
  parser.resolve({ specifier, kind: 'static', line: 1 }, from, repo);

describe('go parser: resolve', () => {
  it('same-module import resolves to every non-test .go file in the package dir', async () => {
    const repo = await indexOf({
      'go.mod': 'module example.com/m\n',
      'main.go': '',
      'internal/db/b.go': '',
      'internal/db/a.go': '',
      'internal/db/a_test.go': '',
      'internal/db/README.md': '',
      'internal/db/sub/c.go': '',
    });
    expect(resolve(repo, 'main.go', 'example.com/m/internal/db')).toEqual({
      kind: 'file',
      paths: ['internal/db/a.go', 'internal/db/b.go'],
    });
  });

  it('the module root package', async () => {
    const repo = await indexOf({
      'go.mod': 'module example.com/m\n',
      'x.go': '',
      'cmd/main.go': '',
    });
    expect(resolve(repo, 'cmd/main.go', 'example.com/m')).toEqual({
      kind: 'file',
      paths: ['x.go'],
    });
  });

  it('a package directory with no non-test files is unresolved', async () => {
    const repo = await indexOf({
      'go.mod': 'module example.com/m\n',
      'only/x_test.go': '',
      'main.go': '',
    });
    const notFound = { kind: 'unresolved', reason: 'not found' };
    expect(resolve(repo, 'main.go', 'example.com/m/only')).toEqual(notFound);
    expect(resolve(repo, 'main.go', 'example.com/m/missing')).toEqual(notFound);
  });

  it('multi-module repo picks the longest module prefix', async () => {
    const repo = await indexOf({
      'go.mod': 'module example.com/m\n',
      'svc/go.mod': 'module example.com/m/svc\n',
      'svc/util/u.go': '',
      'util/root.go': '',
      'main.go': '',
    });
    expect(resolve(repo, 'main.go', 'example.com/m/svc/util')).toEqual({
      kind: 'file',
      paths: ['svc/util/u.go'],
    });
    expect(resolve(repo, 'main.go', 'example.com/m/util')).toEqual({
      kind: 'file',
      paths: ['util/root.go'],
    });
  });

  it('a module path is matched on segment boundaries', async () => {
    const repo = await indexOf({ 'go.mod': 'module example.com/m\n', 'main.go': '' });
    expect(resolve(repo, 'main.go', 'example.com/mx/pkg')).toEqual({
      kind: 'external',
      name: 'example.com/mx/pkg',
    });
  });

  it('stdlib and third-party are external with the full import path', async () => {
    const repo = await indexOf({ 'go.mod': 'module example.com/m\n', 'main.go': '' });
    expect(resolve(repo, 'main.go', 'fmt')).toEqual({ kind: 'external', name: 'fmt' });
    expect(resolve(repo, 'main.go', 'github.com/x/y/z')).toEqual({
      kind: 'external',
      name: 'github.com/x/y/z',
    });
  });
});
