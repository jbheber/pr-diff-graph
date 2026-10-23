import { beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.js';
import { pythonParser } from '../../../src/parsers/python.js';
import { regexImports } from '../../../src/parsers/regex-fallback.js';
import { grammarDir, initTreeSitter } from '../../../src/parsers/treesitter.js';
import { ParseError, type LanguageParser } from '../../../src/parsers/types.js';

let parser: LanguageParser;

beforeAll(async () => {
  parser = pythonParser(await initTreeSitter(grammarDir()), silentLogger);
});

const parse = (source: string, path = 'pkg/a.py') => parser.parse(source, path);

describe('python parser: parse', () => {
  it('plain imports, several per statement, aliases keep the module', () => {
    expect(parse('import a.b, c\nimport x.y as z\n')).toEqual([
      { specifier: 'a.b', kind: 'static', line: 1 },
      { specifier: 'c', kind: 'static', line: 1 },
      { specifier: 'x.y', kind: 'static', line: 2 },
    ]);
  });

  it('from-imports carry the imported names', () => {
    expect(parse('from a.b import c, d as e\n')).toEqual([
      { specifier: 'a.b', kind: 'static', line: 1, names: ['c', 'd'] },
    ]);
  });

  it('relative imports keep their leading dots', () => {
    expect(
      parse('from . import x\nfrom ..pkg import y\nfrom .mod import (\n  p,\n  q,\n)\n'),
    ).toEqual([
      { specifier: '.', kind: 'static', line: 1, names: ['x'] },
      { specifier: '..pkg', kind: 'static', line: 2, names: ['y'] },
      { specifier: '.mod', kind: 'static', line: 3, names: ['p', 'q'] },
    ]);
  });

  it('a wildcard import has no names', () => {
    expect(parse('from x import *\n')).toEqual([{ specifier: 'x', kind: 'static', line: 1 }]);
  });

  it('import inside a function is captured', () => {
    expect(parse('def f():\n    import lazy\n    from m import n\n')).toEqual([
      { specifier: 'lazy', kind: 'static', line: 2 },
      { specifier: 'm', kind: 'static', line: 3, names: ['n'] },
    ]);
  });

  it('strings and comments are ignored', () => {
    const src = '# import nope\ns = "import nope2"\n"""\nimport nope3\n"""\nimport real\n';
    expect(parse(src)).toEqual([{ specifier: 'real', kind: 'static', line: 6 }]);
  });

  it('handles .pyi stubs', () => {
    expect(parse('from typing import Any\n', 'pkg/a.pyi')).toEqual([
      { specifier: 'typing', kind: 'static', line: 1, names: ['Any'] },
    ]);
  });

  it('declares .py and .pyi', () => {
    expect(parser.extensions).toEqual(['.py', '.pyi']);
  });

  it('throws ParseError when nothing is readable', () => {
    expect(() => parser.parse('import (\n', 'pkg/bad.py')).toThrow(ParseError);
  });

  it('agrees with the regex fallback', () => {
    const src = [
      'import a.b, c',
      'import x.y as z',
      'from a.b import c, d as e',
      'from . import x',
      'from ..pkg import y',
      'from m import *',
      'from a import (',
      '  b,',
      '  c,',
      ')',
    ].join('\n');
    const fallback = regexImports('python', src);
    expect(parse(src)).toEqual(fallback);
  });
});
