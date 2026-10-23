import { describe, expect, it } from 'vitest';
import { indexOf } from './helpers.js';

describe('buildRepoIndex', () => {
  it('lists files, skips node_modules, and answers has/listDir/read', async () => {
    const idx = await indexOf({
      'a.ts': 'export const a = 1;\n',
      'src/b.ts': 'é\n',
      'src/sub/c.ts': 'x',
      'node_modules/pkg/index.js': 'x',
      'src/node_modules/pkg/index.js': 'x',
      'my_node_modules/x.js': 'x',
    });
    expect([...idx.files].sort()).toEqual([
      'a.ts',
      'my_node_modules/x.js',
      'src/b.ts',
      'src/sub/c.ts',
    ]);
    expect(idx.has('src/b.ts')).toBe(true);
    expect(idx.has('node_modules/pkg/index.js')).toBe(false);
    expect(idx.listDir('')).toEqual(['a.ts']);
    expect(idx.listDir('src')).toEqual(['src/b.ts']);
    expect(idx.listDir('nope')).toEqual([]);
    expect(await idx.read('src/b.ts')).toBe('é\n');
    expect(await idx.read('missing.ts')).toBeNull();
  });

  it('parses manifests that start with a BOM', async () => {
    const idx = await indexOf({
      'tsconfig.json':
        String.fromCharCode(0xfeff) + JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
    });
    expect(idx.tsconfigs[0]?.baseUrl).toBe('src');
  });
});
