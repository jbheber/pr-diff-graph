import { describe, expect, it } from 'vitest';
import { indexOf } from './helpers.js';

const pkg = (name: string, extra: object = {}) => JSON.stringify({ name, ...extra });

describe('workspaces', () => {
  it('reads npm/yarn workspaces array and object form', async () => {
    const arr = await indexOf({
      'package.json': JSON.stringify({ workspaces: ['packages/a'] }),
      'packages/a/package.json': pkg('a', { main: 'lib/index.js', types: 'lib/index.d.ts' }),
      'packages/b/package.json': pkg('b'),
    });
    expect(arr.workspaces).toEqual([
      {
        name: 'a',
        dir: 'packages/a',
        manifest: { main: 'lib/index.js', types: 'lib/index.d.ts' },
      },
    ]);

    const obj = await indexOf({
      'package.json': JSON.stringify({ workspaces: { packages: ['libs/*'] } }),
      'libs/x/package.json': pkg('x', { exports: { '.': './src/index.ts' } }),
    });
    expect(obj.workspaces).toEqual([
      { name: 'x', dir: 'libs/x', manifest: { exports: { '.': './src/index.ts' } } },
    ]);
  });

  it('reads pnpm-workspace.yaml', async () => {
    const idx = await indexOf({
      'package.json': pkg('root'),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'libs/**'\n  - '!libs/legacy'\n",
      'apps/web/package.json': pkg('web'),
      'libs/ui/package.json': pkg('ui'),
      'libs/legacy/package.json': pkg('legacy'),
      'tools/package.json': pkg('tools'),
    });
    expect(idx.workspaces.map((w) => w.name)).toEqual(['web', 'ui']);
  });

  it('expands globs like packages/*', async () => {
    const idx = await indexOf({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg('a'),
      'packages/b/package.json': pkg('b'),
      'packages/b/nested/package.json': pkg('nested'),
    });
    expect(idx.workspaces.map((w) => w.dir)).toEqual(['packages/a', 'packages/b']);
  });

  it('packageOf returns the owning package', async () => {
    const idx = await indexOf({
      'package.json': JSON.stringify({ workspaces: ['packages/*', 'packages/b/inner'] }),
      'packages/a/package.json': pkg('a'),
      'packages/a/src/x.ts': '',
      'packages/ab/package.json': pkg('ab'),
      'packages/b/package.json': pkg('b'),
      'packages/b/inner/package.json': pkg('inner'),
      'packages/b/inner/y.ts': '',
      'root.ts': '',
    });
    expect(idx.packageOf('packages/a/src/x.ts')?.name).toBe('a');
    expect(idx.packageOf('packages/ab/z.ts')?.name).toBe('ab');
    expect(idx.packageOf('packages/b/inner/y.ts')?.name).toBe('inner');
    expect(idx.packageOf('root.ts')).toBeNull();
  });

  it('ignores a malformed package.json with a warning', async () => {
    const idx = await indexOf({ 'package.json': '{ nope', 'a/package.json': pkg('a') });
    expect(idx.workspaces).toEqual([]);
  });
});
