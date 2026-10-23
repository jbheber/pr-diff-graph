import { beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.js';
import { grammarDir, initTreeSitter } from '../../../src/parsers/treesitter.js';
import { ParseError, type LanguageParser } from '../../../src/parsers/types.js';
import { typescriptParser } from '../../../src/parsers/typescript.js';

let parser: LanguageParser;

beforeAll(async () => {
  parser = typescriptParser(await initTreeSitter(grammarDir()), silentLogger);
});

const parse = (source: string, path = 'src/a.ts') =>
  parser.parse(source, path).map(({ specifier, kind, line }) => ({ specifier, kind, line }));

describe('typescript parser: parse', () => {
  it('static imports: default, named, namespace, side-effect', () => {
    const src = [
      "import a from './default';",
      "import { b, c as d } from './named';",
      "import * as ns from './namespace';",
      "import './side-effect';",
    ].join('\n');
    expect(parse(src)).toEqual([
      { specifier: './default', kind: 'static', line: 1 },
      { specifier: './named', kind: 'static', line: 2 },
      { specifier: './namespace', kind: 'static', line: 3 },
      { specifier: './side-effect', kind: 'static', line: 4 },
    ]);
  });

  it('type-only imports', () => {
    const src = "import type { X } from './t';\nimport { type Y } from './y';\n";
    expect(parse(src)).toEqual([
      { specifier: './t', kind: 'type-only', line: 1 },
      { specifier: './y', kind: 'static', line: 2 },
    ]);
  });

  it('re-exports', () => {
    const src = "export * from './a';\nexport { b } from './b';\nexport const c = 1;\n";
    expect(parse(src)).toEqual([
      { specifier: './a', kind: 'reexport', line: 1 },
      { specifier: './b', kind: 'reexport', line: 2 },
    ]);
  });

  it('dynamic import with literal only', () => {
    const src = "const m = await import('./lazy');\nconst n = await import(name);\n";
    expect(parse(src)).toEqual([{ specifier: './lazy', kind: 'dynamic', line: 1 }]);
  });

  it('require with literal only', () => {
    const src = [
      "const a = require('./a');",
      'const b = require(name);',
      "const c = require('./c', extra);",
      "import d = require('./d');",
    ].join('\n');
    expect(parse(src)).toEqual([
      { specifier: './a', kind: 'require', line: 1 },
      { specifier: './d', kind: 'require', line: 4 },
    ]);
    expect(parse("module.exports = require('./x');\n", 'src/a.cjs')).toEqual([
      { specifier: './x', kind: 'require', line: 1 },
    ]);
  });

  it('triple-slash reference path', () => {
    const src = '/// <reference path="./globals.d.ts" />\n/// <reference types="node" />\n';
    expect(parse(src)).toEqual([{ specifier: './globals.d.ts', kind: 'reference', line: 1 }]);
  });

  it('ignores look-alikes in comments and strings', () => {
    const src = [
      "// import x from './no'",
      'const s = \'import y from "./no"\';',
      "/* require('./no') */",
      "const t = `import('./no')`;",
    ].join('\n');
    expect(parse(src)).toEqual([]);
  });

  it('parses tsx and jsx', () => {
    const tsx =
      'import { Button } from \'./Button\';\nexport const App = () => <Button label="x" />;\n';
    expect(parse(tsx, 'src/App.tsx')).toEqual([{ specifier: './Button', kind: 'static', line: 1 }]);
    const jsx = "import Button from './Button';\nexport const App = () => <div><Button /></div>;\n";
    expect(parse(jsx, 'src/App.jsx')).toEqual([{ specifier: './Button', kind: 'static', line: 1 }]);
    // JSX in a plain .js file is common, so .js uses the tsx grammar too.
    expect(parse(jsx, 'src/App.js')).toEqual([{ specifier: './Button', kind: 'static', line: 1 }]);
  });

  it('throws on syntax error', () => {
    expect(() => parser.parse("import { from './broken';\n", 'src/bad.ts')).toThrow(ParseError);
  });

  it('returns what it read when the tree has errors but imports were found', () => {
    const src = "import a from './a';\nconst = ;\n";
    expect(parse(src)).toEqual([{ specifier: './a', kind: 'static', line: 1 }]);
  });
});
