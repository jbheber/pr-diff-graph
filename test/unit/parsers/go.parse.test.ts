import { beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.js';
import { goParser } from '../../../src/parsers/go.js';
import { grammarDir, initTreeSitter } from '../../../src/parsers/treesitter.js';
import { ParseError, type LanguageParser } from '../../../src/parsers/types.js';

let parser: LanguageParser;

beforeAll(async () => {
  parser = goParser(await initTreeSitter(grammarDir()), silentLogger);
});

const parse = (source: string, path = 'cmd/main.go') => parser.parse(source, path);

describe('go parser: parse', () => {
  it('a single import', () => {
    expect(parse('package main\n\nimport "fmt"\n')).toEqual([
      { specifier: 'fmt', kind: 'static', line: 3 },
    ]);
  });

  it('grouped imports with aliases, dot and blank imports yield specifiers only', () => {
    const src = [
      'package main',
      '',
      'import (',
      '\t"os"',
      '\tstr "strings"',
      '\t. "math"',
      '\t_ "embed"',
      '\t"example.com/mod/pkg/util"',
      ')',
    ].join('\n');
    expect(parse(src)).toEqual([
      { specifier: 'os', kind: 'static', line: 4 },
      { specifier: 'strings', kind: 'static', line: 5 },
      { specifier: 'math', kind: 'static', line: 6 },
      { specifier: 'embed', kind: 'static', line: 7 },
      { specifier: 'example.com/mod/pkg/util', kind: 'static', line: 8 },
    ]);
  });

  it('parses _test.go files', () => {
    expect(
      parse('package x_test\n\nimport "testing"\n', 'pkg/x_test.go').map((i) => i.specifier),
    ).toEqual(['testing']);
  });

  it('ignores import-looking text in comments and strings', () => {
    const src = 'package main\n// import "nope"\nvar s = `import "nope2"`\nimport "real"\n';
    expect(parse(src).map((i) => i.specifier)).toEqual(['real']);
  });

  it('declares .go', () => {
    expect(parser.extensions).toEqual(['.go']);
  });

  it('throws ParseError when nothing is readable', () => {
    expect(() => parser.parse('package main\nimport (\n', 'bad.go')).toThrow(ParseError);
  });
});
