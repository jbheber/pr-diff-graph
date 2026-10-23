import { beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.js';
import { grammarDir, initTreeSitter } from '../../../src/parsers/treesitter.js';
import type { LanguageParser, RawImport, Resolution } from '../../../src/parsers/types.js';
import { typescriptParser } from '../../../src/parsers/typescript.js';
import type { RepoIndex } from '../../../src/repo/index.js';
import type { FileMap } from '../../helpers/gitfixture.js';
import { indexOf } from '../repo/helpers.js';

let parser: LanguageParser;

beforeAll(async () => {
  parser = typescriptParser(await initTreeSitter(grammarDir()), silentLogger);
});

/** Every resolution the tests produce, for the backslash property check. */
const seen: Resolution[] = [];

function resolve(
  repo: RepoIndex,
  from: string,
  specifier: string,
  kind: RawImport['kind'] = 'static',
): Resolution {
  const r = parser.resolve({ specifier, kind, line: 1 }, from, repo);
  seen.push(r);
  return r;
}

const file = (...paths: string[]): Resolution => ({ kind: 'file', paths });
const json = (v: unknown) => JSON.stringify(v);

describe('typescript parser: resolve relative', () => {
  it('relative with extension', async () => {
    const repo = await indexOf({ 'src/a.ts': '', 'src/b.ts': '' });
    expect(resolve(repo, 'src/a.ts', './b.ts')).toEqual(file('src/b.ts'));
  });

  it('extensionless, probing in order', async () => {
    const repo = await indexOf({
      'src/a.ts': '',
      'src/b.ts': '',
      'src/b.js': '',
      'src/c.js': '',
      'src/c.tsx': '',
      'src/d.d.ts': '',
      'src/d.js': '',
      'src/e.mjs': '',
      'lib/f.cts': '',
    });
    expect(resolve(repo, 'src/a.ts', './b')).toEqual(file('src/b.ts'));
    expect(resolve(repo, 'src/a.ts', './c')).toEqual(file('src/c.tsx'));
    expect(resolve(repo, 'src/a.ts', './d')).toEqual(file('src/d.d.ts'));
    expect(resolve(repo, 'src/a.ts', './e')).toEqual(file('src/e.mjs'));
    expect(resolve(repo, 'src/a.ts', '../lib/f')).toEqual(file('lib/f.cts'));
  });

  it('index file, with and without a trailing slash', async () => {
    const repo = await indexOf({
      'src/a.ts': '',
      'src/dir/index.ts': '',
      'src/dir/x.ts': '',
      'src/js/index.js': '',
    });
    expect(resolve(repo, 'src/a.ts', './dir')).toEqual(file('src/dir/index.ts'));
    expect(resolve(repo, 'src/a.ts', './dir/')).toEqual(file('src/dir/index.ts'));
    expect(resolve(repo, 'src/a.ts', './js')).toEqual(file('src/js/index.js'));
    expect(resolve(repo, 'src/dir/x.ts', '.')).toEqual(file('src/dir/index.ts'));
    expect(resolve(repo, 'src/js/index.js', '../dir')).toEqual(file('src/dir/index.ts'));
  });

  it('.js written in TS source maps to .ts', async () => {
    const repo = await indexOf({
      'src/a.ts': '',
      'src/b.ts': '',
      'src/c.tsx': '',
      'src/d.js': '',
      'src/d.ts': '',
      'src/e.mts': '',
    });
    expect(resolve(repo, 'src/a.ts', './b.js')).toEqual(file('src/b.ts'));
    expect(resolve(repo, 'src/a.ts', './c.js')).toEqual(file('src/c.tsx'));
    expect(resolve(repo, 'src/a.ts', './d.js')).toEqual(file('src/d.js'));
    expect(resolve(repo, 'src/a.ts', './e.mjs')).toEqual(file('src/e.mts'));
  });

  it('directory with package.json main', async () => {
    const repo = await indexOf({
      'src/a.ts': '',
      'src/vendor/package.json': json({ main: './lib/entry.js' }),
      'src/vendor/lib/entry.js': '',
      'src/typed/package.json': json({ main: 'out/x.js', types: 'types/x.d.ts' }),
      'src/typed/types/x.d.ts': '',
    });
    expect(resolve(repo, 'src/a.ts', './vendor')).toEqual(file('src/vendor/lib/entry.js'));
    expect(resolve(repo, 'src/a.ts', './typed')).toEqual(file('src/typed/types/x.d.ts'));
  });

  it('strips a query or hash and resolves non-code files that exist', async () => {
    const repo = await indexOf({
      'src/a.tsx': '',
      'src/x.svg': '',
      'src/styles.css': '',
      'src/data.json': '',
      'src/m.ts': '',
    });
    expect(resolve(repo, 'src/a.tsx', './x.svg?react')).toEqual(file('src/x.svg'));
    expect(resolve(repo, 'src/a.tsx', './styles.css')).toEqual(file('src/styles.css'));
    expect(resolve(repo, 'src/a.tsx', './data.json')).toEqual(file('src/data.json'));
    expect(resolve(repo, 'src/a.tsx', './m#frag')).toEqual(file('src/m.ts'));
  });

  it('relative to a missing file is unresolved: not found', async () => {
    const repo = await indexOf({ 'src/a.ts': '' });
    const notFound = { kind: 'unresolved', reason: 'not found' };
    expect(resolve(repo, 'src/a.ts', './missing')).toEqual(notFound);
    expect(resolve(repo, 'src/a.ts', './missing.css')).toEqual(notFound);
    expect(resolve(repo, 'src/a.ts', '../../outside')).toEqual(notFound);
  });

  it('triple-slash references resolve relative only', async () => {
    const repo = await indexOf({
      'src/a.ts': '',
      'src/globals.d.ts': '',
      'tsconfig.json': json({ compilerOptions: { baseUrl: '.' } }),
      'types.d.ts': '',
    });
    expect(resolve(repo, 'src/a.ts', 'globals.d.ts', 'reference')).toEqual(
      file('src/globals.d.ts'),
    );
    expect(resolve(repo, 'src/a.ts', './globals.d.ts', 'reference')).toEqual(
      file('src/globals.d.ts'),
    );
    expect(resolve(repo, 'src/a.ts', 'types.d.ts', 'reference')).toEqual({
      kind: 'unresolved',
      reason: 'not found',
    });
  });
});

describe('typescript parser: resolve with tsconfig', () => {
  it('paths wildcard', async () => {
    const repo = await indexOf({
      'tsconfig.json': json({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
      'src/app/a.ts': '',
      'src/utils/x.ts': '',
    });
    expect(resolve(repo, 'src/app/a.ts', '@/utils/x')).toEqual(file('src/utils/x.ts'));
  });

  it('paths exact pattern and longest prefix wins', async () => {
    const repo = await indexOf({
      'tsconfig.json': json({
        compilerOptions: {
          paths: { config: ['src/config/index.ts'], '@/*': ['src/*'], '@/ui/*': ['ui/*'] },
        },
      }),
      'src/a.ts': '',
      'src/config/index.ts': '',
      'ui/button.tsx': '',
    });
    expect(resolve(repo, 'src/a.ts', 'config')).toEqual(file('src/config/index.ts'));
    expect(resolve(repo, 'src/a.ts', '@/ui/button')).toEqual(file('ui/button.tsx'));
  });

  it('paths multiple targets fall through to the second', async () => {
    const repo = await indexOf({
      'tsconfig.json': json({
        compilerOptions: { paths: { '~/*': ['generated/*', 'src/*'] } },
      }),
      'src/a.ts': '',
      'src/lib/y.ts': '',
    });
    expect(resolve(repo, 'src/a.ts', '~/lib/y')).toEqual(file('src/lib/y.ts'));
  });

  it('an alias that matches but finds nothing is unresolved: not found', async () => {
    const repo = await indexOf({
      'tsconfig.json': json({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
      'src/a.ts': '',
    });
    expect(resolve(repo, 'src/a.ts', '@/nope')).toEqual({
      kind: 'unresolved',
      reason: 'not found',
    });
  });

  it('baseUrl bare import', async () => {
    const repo = await indexOf({
      'tsconfig.json': json({ compilerOptions: { baseUrl: 'src' } }),
      'src/pages/home.ts': '',
      'src/components/Button.tsx': '',
    });
    expect(resolve(repo, 'src/pages/home.ts', 'components/Button')).toEqual(
      file('src/components/Button.tsx'),
    );
    expect(resolve(repo, 'src/pages/home.ts', 'react')).toEqual({
      kind: 'external',
      name: 'react',
    });
  });

  it('nearest tsconfig wins in a monorepo', async () => {
    const repo = await indexOf({
      'tsconfig.json': json({ compilerOptions: { paths: { '@/*': ['shared/*'] } } }),
      'shared/x.ts': '',
      'apps/web/tsconfig.json': json({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      'apps/web/src/main.ts': '',
      'apps/web/src/x.ts': '',
      'tools/a.ts': '',
    });
    expect(resolve(repo, 'apps/web/src/main.ts', '@/x')).toEqual(file('apps/web/src/x.ts'));
    expect(resolve(repo, 'tools/a.ts', '@/x')).toEqual(file('shared/x.ts'));
  });
});

describe('typescript parser: resolve workspace packages', () => {
  const root = { 'package.json': json({ private: true, workspaces: ['packages/*'] }) };

  it('package root via exports["."], source condition first', async () => {
    const repo = await indexOf({
      ...root,
      'packages/ui/package.json': json({
        name: '@acme/ui',
        exports: {
          '.': { import: './dist/index.mjs', source: './src/index.ts', types: './dist/index.d.ts' },
        },
      }),
      'packages/ui/src/index.ts': '',
      'packages/ui/src/other.ts': '',
      'apps/web/a.ts': '',
    });
    expect(resolve(repo, 'apps/web/a.ts', '@acme/ui')).toEqual(file('packages/ui/src/index.ts'));
  });

  it('exports as a string and as a bare conditions object', async () => {
    const repo = await indexOf({
      ...root,
      'packages/a/package.json': json({ name: 'a', exports: './src/main.ts' }),
      'packages/a/src/main.ts': '',
      'packages/b/package.json': json({
        name: 'b',
        exports: { default: './lib.js', types: './types.d.ts' },
      }),
      'packages/b/lib.js': '',
      'packages/b/types.d.ts': '',
      'x.ts': '',
    });
    expect(resolve(repo, 'x.ts', 'a')).toEqual(file('packages/a/src/main.ts'));
    expect(resolve(repo, 'x.ts', 'b')).toEqual(file('packages/b/types.d.ts'));
  });

  it('nested conditions, arrays and null targets', async () => {
    const repo = await indexOf({
      ...root,
      'packages/n/package.json': json({
        name: 'n',
        exports: {
          '.': { import: { types: './missing.d.ts', default: ['./nope.js', './real.js'] } },
          './blocked': null,
        },
      }),
      'packages/n/real.js': '',
      'packages/n/blocked.ts': '',
      'x.ts': '',
    });
    expect(resolve(repo, 'x.ts', 'n')).toEqual(file('packages/n/real.js'));
    expect(resolve(repo, 'x.ts', 'n/blocked')).toEqual({
      kind: 'unresolved',
      reason: 'not found',
    });
  });

  it('package subpath via exports["./button"] and via a "./*" pattern', async () => {
    const repo = await indexOf({
      ...root,
      'packages/ui/package.json': json({
        name: '@acme/ui',
        exports: {
          './button': { source: './src/button/index.tsx' },
          './*': { types: './dist/*.d.ts', default: './dist/*.js' },
        },
      }),
      'packages/ui/src/button/index.tsx': '',
      'packages/ui/src/card.tsx': '',
      'apps/web/a.ts': '',
    });
    expect(resolve(repo, 'apps/web/a.ts', '@acme/ui/button')).toEqual(
      file('packages/ui/src/button/index.tsx'),
    );
    expect(resolve(repo, 'apps/web/a.ts', '@acme/ui/card')).toEqual(
      file('packages/ui/src/card.tsx'),
    );
  });

  it('dist mapped back to src', async () => {
    const repo = await indexOf({
      ...root,
      'packages/ui/package.json': json({ name: '@acme/ui', main: 'dist/index.js' }),
      'packages/ui/src/index.ts': '',
      'packages/typed/package.json': json({ name: 'typed', types: 'build/api.d.ts' }),
      'packages/typed/src/api.ts': '',
      'packages/odd/package.json': json({ name: 'odd', main: 'out/bundle.js' }),
      'packages/odd/src/index.tsx': '',
      'apps/web/a.ts': '',
    });
    expect(resolve(repo, 'apps/web/a.ts', '@acme/ui')).toEqual(file('packages/ui/src/index.ts'));
    expect(resolve(repo, 'apps/web/a.ts', 'typed')).toEqual(file('packages/typed/src/api.ts'));
    expect(resolve(repo, 'apps/web/a.ts', 'odd')).toEqual(file('packages/odd/src/index.tsx'));
  });

  it('no exports or main: src/index.* fallback; subpath without exports', async () => {
    const repo = await indexOf({
      ...root,
      'packages/p/package.json': json({ name: 'p' }),
      'packages/p/src/index.ts': '',
      'packages/p/utils/fmt.ts': '',
      'x.ts': '',
    });
    expect(resolve(repo, 'x.ts', 'p')).toEqual(file('packages/p/src/index.ts'));
    expect(resolve(repo, 'x.ts', 'p/utils/fmt')).toEqual(file('packages/p/utils/fmt.ts'));
  });

  it('a workspace package that resolves to nothing is unresolved: not found', async () => {
    const repo = await indexOf({
      ...root,
      'packages/p/package.json': json({ name: 'p' }),
      'packages/p/README.md': '',
      'x.ts': '',
    });
    expect(resolve(repo, 'x.ts', 'p')).toEqual({ kind: 'unresolved', reason: 'not found' });
  });
});

describe('typescript parser: resolve externals', () => {
  it('bare external, scoped subpath, node: builtin', async () => {
    const repo = await indexOf({ 'src/a.ts': '' } satisfies FileMap);
    expect(resolve(repo, 'src/a.ts', 'react')).toEqual({ kind: 'external', name: 'react' });
    expect(resolve(repo, 'src/a.ts', 'react/jsx-runtime')).toEqual({
      kind: 'external',
      name: 'react',
    });
    expect(resolve(repo, 'src/a.ts', '@scope/pkg/sub')).toEqual({
      kind: 'external',
      name: '@scope/pkg',
    });
    expect(resolve(repo, 'src/a.ts', 'node:fs')).toEqual({ kind: 'external', name: 'node:fs' });
    expect(resolve(repo, 'src/a.ts', 'node:fs/promises')).toEqual({
      kind: 'external',
      name: 'node:fs',
    });
  });

  it('never returns backslashes', () => {
    expect(seen.length).toBeGreaterThan(30);
    for (const r of seen) expect(JSON.stringify(r)).not.toContain('\\\\');
  });
});

describe('typescript parser: specifiers named like Object.prototype members', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    '%s resolves as external, never throws',
    async (spec) => {
      const repo = await indexOf({
        'tsconfig.json': json({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
        'package.json': json({ name: 'root' }),
        'a.ts': '',
      });
      expect(() => resolve(repo, 'a.ts', spec)).not.toThrow();
      expect(resolve(repo, 'a.ts', spec)).toEqual({ kind: 'external', name: spec });
    },
  );

  it('a package exports map does not inherit Object.prototype members', async () => {
    const repo = await indexOf({
      'package.json': json({ workspaces: ['packages/*'] }),
      'packages/lib/package.json': json({ name: 'lib', exports: { '.': './index.ts' } }),
      'packages/lib/index.ts': '',
      'a.ts': '',
    });
    expect(() => resolve(repo, 'a.ts', 'lib/constructor')).not.toThrow();
    expect(() => resolve(repo, 'a.ts', 'lib/__proto__')).not.toThrow();
  });
});
