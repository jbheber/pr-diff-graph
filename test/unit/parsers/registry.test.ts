import { beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/log.js';
import type { RepoIndex } from '../../../src/repo/index.js';
import { regexImports } from '../../../src/parsers/regex-fallback.js';
import { createRegistry } from '../../../src/parsers/registry.js';
import {
  grammarDir,
  initTreeSitter,
  type TreeSitterRuntime,
} from '../../../src/parsers/treesitter.js';

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, info() {}, warn: (m) => warnings.push(m), debug() {} };
}

let rt: TreeSitterRuntime;

beforeAll(async () => {
  rt = await initTreeSitter(grammarDir());
});

describe('tree-sitter runtime', () => {
  it('loads all five grammars', () => {
    for (const name of ['typescript', 'tsx', 'javascript', 'python', 'go'] as const) {
      expect(rt.language(name), name).not.toBeNull();
    }
  });

  it('returns null languages and warns when the grammar dir is missing', async () => {
    const log = recordingLogger();
    const broken = await initTreeSitter('does/not/exist', log);
    expect(broken.language('typescript')).toBeNull();
    expect(log.warnings.length).toBeGreaterThan(0);
  });
});

describe('parser registry', () => {
  it('maps extensions to parsers', () => {
    const reg = createRegistry(rt, recordingLogger());
    for (const p of [
      'a.ts',
      'a.d.ts',
      'a.tsx',
      'a.mts',
      'a.cts',
      'a.js',
      'a.jsx',
      'a.mjs',
      'dir.v2/a.cjs',
      'A.TS',
    ]) {
      expect(reg.forPath(p)?.id, p).toBe('typescript');
    }
    expect(reg.parsers.map((p) => p.id)).toContain('typescript');
  });

  it('returns null for .vue/.json/.md', () => {
    const reg = createRegistry(rt, recordingLogger());
    for (const p of ['a.vue', 'package.json', 'README.md', 'Makefile', 'x.ts/README', '.ts']) {
      expect(reg.forPath(p), p).toBeNull();
    }
  });

  it('falls back to regex when a grammar failed to load', () => {
    const log = recordingLogger();
    const reg = createRegistry({ language: () => null }, log);
    const ts = reg.forPath('src/a.ts')!;
    const src = "import a from './a';\nexport * from './b';\n";
    expect(ts.parse(src, 'src/a.ts')).toEqual([
      { specifier: './a', kind: 'static', line: 1 },
      { specifier: './b', kind: 'reexport', line: 2 },
    ]);
    expect(ts.parse(src, 'src/c.tsx')).toHaveLength(2);
    expect(ts.parse(src, 'src/d.ts')).toHaveLength(2);
    expect(log.warnings.filter((w) => w.includes('regex'))).toHaveLength(1);
  });

  it('resolve is not implemented yet', () => {
    const reg = createRegistry(rt, recordingLogger());
    const ts = reg.forPath('a.ts')!;
    const repo = {} as RepoIndex;
    expect(ts.resolve({ specifier: './b', kind: 'static', line: 1 }, 'a.ts', repo)).toEqual({
      kind: 'unresolved',
      reason: 'not implemented',
    });
  });
});

describe('regex fallback', () => {
  it('typescript: every import form, lines, literal-only', () => {
    const src = [
      "import a from './default';",
      "import type { T } from './t';",
      "import './side';",
      "export { b } from './b';",
      "const l = import('./lazy');",
      "const r = require('./req');",
      'const n = require(name);',
      '/// <reference path="./g.d.ts" />',
      'import {',
      '  x,',
      "} from './multi';",
    ].join('\n');
    expect(regexImports('typescript', src)).toEqual([
      { specifier: './default', kind: 'static', line: 1 },
      { specifier: './t', kind: 'type-only', line: 2 },
      { specifier: './side', kind: 'static', line: 3 },
      { specifier: './b', kind: 'reexport', line: 4 },
      { specifier: './lazy', kind: 'dynamic', line: 5 },
      { specifier: './req', kind: 'require', line: 6 },
      { specifier: './g.d.ts', kind: 'reference', line: 8 },
      { specifier: './multi', kind: 'static', line: 9 },
    ]);
  });

  it('python: import and from-import, relative', () => {
    const src = 'import os, a.b as ab\nfrom . import x\nfrom ..pkg import (y, z as w)\n';
    expect(regexImports('python', src)).toEqual([
      { specifier: 'os', kind: 'static', line: 1 },
      { specifier: 'a.b', kind: 'static', line: 1 },
      { specifier: '.', kind: 'static', line: 2, names: ['x'] },
      { specifier: '..pkg', kind: 'static', line: 3, names: ['y', 'z'] },
    ]);
  });

  it('go: single and grouped imports', () => {
    const src = 'package main\n\nimport "fmt"\nimport (\n\t"os"\n\tm "example.com/mod/x"\n)\n';
    expect(regexImports('go', src)).toEqual([
      { specifier: 'fmt', kind: 'static', line: 3 },
      { specifier: 'os', kind: 'static', line: 5 },
      { specifier: 'example.com/mod/x', kind: 'static', line: 6 },
    ]);
  });
});
