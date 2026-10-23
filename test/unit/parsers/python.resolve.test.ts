import { beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.js';
import { pythonParser } from '../../../src/parsers/python.js';
import { grammarDir, initTreeSitter } from '../../../src/parsers/treesitter.js';
import type { LanguageParser, Resolution } from '../../../src/parsers/types.js';
import type { RepoIndex } from '../../../src/repo/index.js';
import { indexOf } from '../repo/helpers.js';

let parser: LanguageParser;

beforeAll(async () => {
  parser = pythonParser(await initTreeSitter(grammarDir()), silentLogger);
});

function resolve(repo: RepoIndex, from: string, specifier: string, names?: string[]): Resolution {
  return parser.resolve(
    { specifier, kind: 'static', line: 1, ...(names ? { names } : {}) },
    from,
    repo,
  );
}

const file = (...paths: string[]): Resolution => ({ kind: 'file', paths });
const notFound: Resolution = { kind: 'unresolved', reason: 'not found' };

describe('python parser: resolve', () => {
  it('absolute module file', async () => {
    const repo = await indexOf({ 'app/__init__.py': '', 'app/models.py': '', 'main.py': '' });
    expect(resolve(repo, 'main.py', 'app.models')).toEqual(file('app/models.py'));
  });

  it('package __init__', async () => {
    const repo = await indexOf({ 'app/__init__.py': '', 'main.py': '' });
    expect(resolve(repo, 'main.py', 'app')).toEqual(file('app/__init__.py'));
  });

  it('stub files and module-over-package precedence', async () => {
    const repo = await indexOf({
      'a.pyi': '',
      'b.py': '',
      'b/__init__.py': '',
      'c/__init__.pyi': '',
      'main.py': '',
    });
    expect(resolve(repo, 'main.py', 'a')).toEqual(file('a.pyi'));
    expect(resolve(repo, 'main.py', 'b')).toEqual(file('b.py'));
    expect(resolve(repo, 'main.py', 'c')).toEqual(file('c/__init__.pyi'));
  });

  it('src layout', async () => {
    const repo = await indexOf({ 'src/app/__init__.py': '', 'src/app/models.py': '', 'x.py': '' });
    expect(resolve(repo, 'x.py', 'app.models')).toEqual(file('src/app/models.py'));
  });

  it('first root in order wins', async () => {
    const repo = await indexOf({ 'm.py': '', 'src/m.py': '', 'x.py': '' });
    expect(resolve(repo, 'x.py', 'm')).toEqual(file('m.py'));
  });

  it('from-import of a submodule', async () => {
    const repo = await indexOf({ 'app/__init__.py': '', 'app/models.py': '', 'main.py': '' });
    expect(resolve(repo, 'main.py', 'app', ['models'])).toEqual(file('app/models.py'));
  });

  it('from-import of a name falls back to the module', async () => {
    const repo = await indexOf({ 'app/__init__.py': '', 'app/models.py': '', 'main.py': '' });
    expect(resolve(repo, 'main.py', 'app.models', ['User'])).toEqual(file('app/models.py'));
  });

  it('from-import mixing submodules and names yields every file, sorted', async () => {
    const repo = await indexOf({
      'app/__init__.py': '',
      'app/b.py': '',
      'app/a.py': '',
      'm.py': '',
    });
    expect(resolve(repo, 'm.py', 'app', ['b', 'a', 'helper'])).toEqual(
      file('app/__init__.py', 'app/a.py', 'app/b.py'),
    );
    expect(resolve(repo, 'm.py', 'app', ['b', 'a'])).toEqual(file('app/a.py', 'app/b.py'));
  });

  it('relative one and two dots', async () => {
    const repo = await indexOf({
      'pkg/__init__.py': '',
      'pkg/a.py': '',
      'pkg/b.py': '',
      'pkg/sub/__init__.py': '',
      'pkg/sub/c.py': '',
      'top.py': '',
    });
    expect(resolve(repo, 'pkg/a.py', '.b')).toEqual(file('pkg/b.py'));
    expect(resolve(repo, 'pkg/a.py', '.')).toEqual(file('pkg/__init__.py'));
    expect(resolve(repo, 'pkg/a.py', '.', ['b'])).toEqual(file('pkg/b.py'));
    expect(resolve(repo, 'pkg/sub/c.py', '.')).toEqual(file('pkg/sub/__init__.py'));
    expect(resolve(repo, 'pkg/sub/c.py', '..a')).toEqual(file('pkg/a.py'));
    expect(resolve(repo, 'pkg/sub/c.py', '..')).toEqual(file('pkg/__init__.py'));
    expect(resolve(repo, 'pkg/sub/c.py', '...top')).toEqual(file('top.py'));
  });

  it('relative beyond the repo root is unresolved', async () => {
    const repo = await indexOf({ 'pkg/a.py': '', 'top.py': '' });
    expect(resolve(repo, 'pkg/a.py', '...x')).toEqual(notFound);
    expect(resolve(repo, 'top.py', '..x')).toEqual(notFound);
  });

  it('relative to a missing module is unresolved', async () => {
    const repo = await indexOf({ 'pkg/a.py': '' });
    expect(resolve(repo, 'pkg/a.py', '.nope')).toEqual(notFound);
  });

  it('stdlib and third-party are external, named by the first segment', async () => {
    const repo = await indexOf({ 'main.py': '' });
    expect(resolve(repo, 'main.py', 'os')).toEqual({ kind: 'external', name: 'os' });
    expect(resolve(repo, 'main.py', 'requests.adapters')).toEqual({
      kind: 'external',
      name: 'requests',
    });
  });

  it('names that are prototype keys do not confuse resolution', async () => {
    const repo = await indexOf({ 'main.py': '' });
    expect(resolve(repo, 'main.py', 'constructor')).toEqual({
      kind: 'external',
      name: 'constructor',
    });
    expect(resolve(repo, 'main.py', '__proto__.x')).toEqual({
      kind: 'external',
      name: '__proto__',
    });
  });
});
