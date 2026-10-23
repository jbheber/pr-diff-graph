import { describe, expect, it } from 'vitest';
import { indexOf, recordingLogger } from './helpers.js';

describe('tsconfig', () => {
  it('merges extends chain child-over-parent', async () => {
    const idx = await indexOf({
      'tsconfig.json': JSON.stringify({
        extends: './config/base.json',
        compilerOptions: { strict: true },
      }),
      'config/base.json': JSON.stringify({
        compilerOptions: { baseUrl: '..', paths: { '@/*': ['src/*'] } },
      }),
    });
    expect(idx.tsconfigs).toEqual([{ dir: '', baseUrl: '', paths: { '@/*': ['src/*'] } }]);
  });

  it('lets the child override baseUrl and paths, and supports an extends array', async () => {
    const idx = await indexOf({
      'a.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { 'a/*': ['x/*'] } } }),
      'b.json': JSON.stringify({ compilerOptions: { paths: { 'b/*': ['y/*'] } } }),
      'pkg/tsconfig.json': JSON.stringify({
        extends: ['../a.json', '../b.json'],
        compilerOptions: { baseUrl: 'lib' },
      }),
    });
    // b.json's paths win over a.json's; with the child's baseUrl they resolve under pkg/lib.
    expect(idx.tsconfigs).toEqual([
      { dir: 'pkg', baseUrl: 'pkg/lib', paths: { 'b/*': ['pkg/lib/y/*'] } },
    ]);
  });

  it('resolves paths against the config dir when there is no baseUrl', async () => {
    const idx = await indexOf({
      'packages/web/tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '~/*': ['./src/*'] } },
      }),
    });
    expect(idx.tsconfigs).toEqual([
      { dir: 'packages/web', baseUrl: null, paths: { '~/*': ['packages/web/src/*'] } },
    ]);
  });

  it('reads JSONC with comments and trailing commas', async () => {
    const idx = await indexOf({
      'tsconfig.json': `{
  // a comment
  "compilerOptions": {
    /* block */ "baseUrl": "src", // trailing
    "paths": { "@x/*": ["x/*",], },
  },
}
`,
    });
    expect(idx.tsconfigs[0]).toEqual({
      dir: '',
      baseUrl: 'src',
      paths: { '@x/*': ['src/x/*'] },
    });
  });

  it('ignores an extends to an uninstalled package with a warning', async () => {
    const log = recordingLogger();
    const idx = await indexOf(
      {
        'tsconfig.json': JSON.stringify({
          extends: '@tsconfig/node20/tsconfig.json',
          compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
        }),
      },
      log,
    );
    expect(idx.tsconfigs[0]).toEqual({ dir: '', baseUrl: '', paths: { '@/*': ['src/*'] } });
    expect(log.warnings.some((w) => w.includes('@tsconfig/node20'))).toBe(true);
  });

  it('resolves an extends to a workspace package inside the repo', async () => {
    const idx = await indexOf({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/config/package.json': JSON.stringify({ name: '@acme/config' }),
      'packages/config/tsconfig.base.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@acme/*': ['../*/src'] } },
      }),
      'tsconfig.json': JSON.stringify({ extends: '@acme/config/tsconfig.base.json' }),
    });
    expect(idx.nearestTsConfig('x.ts')).toEqual({
      dir: '',
      baseUrl: 'packages/config',
      paths: { '@acme/*': ['packages/*/src'] },
    });
  });

  it('survives circular extends', async () => {
    const log = recordingLogger();
    const idx = await indexOf(
      {
        'tsconfig.json': JSON.stringify({ extends: './other.json' }),
        'other.json': JSON.stringify({ extends: './tsconfig.json' }),
      },
      log,
    );
    expect(idx.tsconfigs).toHaveLength(1);
    expect(log.warnings.some((w) => w.includes('circular'))).toBe(true);
  });

  it('nearestTsConfig picks the closest ancestor', async () => {
    const idx = await indexOf({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }),
      'packages/web/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
      'packages/api/index.ts': '',
    });
    expect(idx.nearestTsConfig('packages/web/src/a.ts')?.dir).toBe('packages/web');
    expect(idx.nearestTsConfig('packages/web/tsconfig.json')?.dir).toBe('packages/web');
    expect(idx.nearestTsConfig('packages/api/index.ts')?.dir).toBe('');
    expect(idx.nearestTsConfig('top.ts')?.dir).toBe('');
  });

  it('returns null when there is no config above the file', async () => {
    const idx = await indexOf({ 'sub/tsconfig.json': '{}', 'other/a.ts': '' });
    expect(idx.nearestTsConfig('other/a.ts')).toBeNull();
  });

  it('jsconfig.json is used when no tsconfig exists', async () => {
    const idx = await indexOf({
      'web/jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }),
      'app/jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'js' } }),
      'app/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'ts' } }),
    });
    expect(idx.nearestTsConfig('web/a.js')).toEqual({ dir: 'web', baseUrl: 'web', paths: {} });
    expect(idx.nearestTsConfig('app/a.js')?.baseUrl).toBe('app/ts');
  });

  it('adopts paths from a referenced config when the solution config has none', async () => {
    const idx = await indexOf({
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [{ path: './tsconfig.node.json' }, { path: './tsconfig.app.json' }],
      }),
      'tsconfig.node.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'tsconfig.app.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/*'] } },
      }),
    });
    expect(idx.tsconfigs).toEqual([{ dir: '', baseUrl: null, paths: { '@/*': ['src/*'] } }]);
  });
});
