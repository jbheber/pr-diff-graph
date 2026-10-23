import { describe, expect, it } from 'vitest';
import { assignClusters, clusterFor, MAX_CLUSTER_FILES } from '../../../src/graph/clusters.js';
import type { GraphCluster } from '../../../src/graph/types.js';
import type { WorkspacePackage } from '../../../src/repo/index.js';

const ui: WorkspacePackage = { name: '@acme/ui', dir: 'packages/ui', manifest: {} };

describe('clusterFor', () => {
  it('workspace package is the outer cluster', () => {
    expect(clusterFor('packages/ui/src/components/Button.tsx', ui, 2)).toEqual([
      'c:packages/ui',
      'c:packages/ui/src',
    ]);
    expect(clusterFor('packages/ui/src/components/Button.tsx', ui, 3)).toEqual([
      'c:packages/ui',
      'c:packages/ui/src/components',
    ]);
    expect(clusterFor('packages/ui/src/components/Button.tsx', ui, 1)).toEqual(['c:packages/ui']);
    expect(clusterFor('packages/ui/package.json', ui, 2)).toEqual(['c:packages/ui']);
  });

  it('plain dirs collapse to depth 2', () => {
    expect(clusterFor('services/go/internal/db/db.go', null, 2)).toEqual(['c:services/go']);
    expect(clusterFor('src/a.ts', null, 2)).toEqual(['c:src']);
    expect(clusterFor('services/go/internal/db/db.go', null, 3)).toEqual([
      'c:services/go/internal',
    ]);
  });

  it('root files go to cluster c:.', () => {
    expect(clusterFor('README.md', null, 2)).toEqual(['c:.']);
    expect(clusterFor('README.md', null, 0)).toEqual(['c:.']);
  });

  it('a root workspace package does not wrap everything', () => {
    const root: WorkspacePackage = { name: 'root', dir: '', manifest: {} };
    expect(clusterFor('src/a.ts', root, 2)).toEqual(['c:src']);
  });
});

/** `n` files named `f0.ts`… in `dir`. */
const filesIn = (dir: string, n: number) => Array.from({ length: n }, (_, i) => `${dir}/f${i}.ts`);
const plain = (paths: string[]) => paths.map((path) => ({ path, pkg: null }));
const shape = (clusters: GraphCluster[]) => clusters.map((c) => [c.id, c.label, c.parent]);

describe('assignClusters', () => {
  const app = [
    ...filesIn('src/app/modules/a', 25),
    ...filesIn('src/app/modules/b', 25),
    ...filesIn('src/app/types', 15),
    ...filesIn('src/app/hooks', 15),
  ];

  it('splits clusters above MAX_CLUSTER_FILES by subdirectory, recursively', () => {
    expect(MAX_CLUSTER_FILES).toBe(30);
    const { clusters, clusterOf } = assignClusters(plain(app), 2);
    expect(shape(clusters)).toEqual([
      ['c:src/app', 'src/app', null],
      ['c:src/app/hooks', 'hooks', 'c:src/app'],
      ['c:src/app/modules', 'modules', 'c:src/app'],
      ['c:src/app/modules/a', 'a', 'c:src/app/modules'],
      ['c:src/app/modules/b', 'b', 'c:src/app/modules'],
      ['c:src/app/types', 'types', 'c:src/app'],
    ]);
    const sizes = new Map<string, number>();
    for (const id of clusterOf.values()) sizes.set(id, (sizes.get(id) ?? 0) + 1);
    expect(Math.max(...sizes.values())).toBeLessThanOrEqual(MAX_CLUSTER_FILES);
    expect(clusterOf.get('src/app/modules/a/f3.ts')).toBe('c:src/app/modules/a');
    expect(clusterOf.get('src/app/types/f0.ts')).toBe('c:src/app/types');
  });

  it('keeps files directly in a split directory in it', () => {
    const { clusters, clusterOf } = assignClusters(
      plain([...app, 'src/app/App.tsx', 'src/app/modules/index.ts']),
      2,
    );
    expect(clusterOf.get('src/app/App.tsx')).toBe('c:src/app');
    expect(clusterOf.get('src/app/modules/index.ts')).toBe('c:src/app/modules');
    expect(clusters).toHaveLength(6);
  });

  it('leaves clusters of up to MAX_CLUSTER_FILES whole', () => {
    const paths = [...filesIn('src/app/a', 15), ...filesIn('src/app/b', 15), 'README.md'];
    const { clusters, clusterOf } = assignClusters(plain(paths), 2);
    expect(shape(clusters)).toEqual([
      ['c:.', '.', null],
      ['c:src/app', 'src/app', null],
    ]);
    expect(clusterOf.get('src/app/b/f1.ts')).toBe('c:src/app');
  });

  it('merges a cluster holding only one child cluster into the child', () => {
    const paths = [...filesIn('src/app/x/y/z/p', 20), ...filesIn('src/app/x/y/z/q', 15)];
    const { clusters, clusterOf } = assignClusters(plain(paths), 2);
    expect(shape(clusters)).toEqual([
      ['c:src/app/x/y/z', 'src/app/x/y/z', null],
      ['c:src/app/x/y/z/p', 'p', 'c:src/app/x/y/z'],
      ['c:src/app/x/y/z/q', 'q', 'c:src/app/x/y/z'],
    ]);
    expect(clusterOf.get('src/app/x/y/z/q/f0.ts')).toBe('c:src/app/x/y/z/q');

    const flat = assignClusters(plain(filesIn('src/app/x', 31)), 2);
    expect(shape(flat.clusters)).toEqual([['c:src/app/x', 'src/app/x', null]]);
  });

  it('keeps a workspace package as the outermost cluster', () => {
    const paths = [...filesIn('packages/ui/src/a', 20), ...filesIn('packages/ui/src/b', 20)];
    const inUi = paths.map((path) => ({ path, pkg: ui }));
    expect(shape(assignClusters(inUi, 2).clusters)).toEqual([
      ['c:packages/ui', 'packages/ui', null],
      ['c:packages/ui/src', 'src', 'c:packages/ui'],
      ['c:packages/ui/src/a', 'a', 'c:packages/ui/src'],
      ['c:packages/ui/src/b', 'b', 'c:packages/ui/src'],
    ]);
    // Depth 1 starts from the package alone; it splits but is never merged away.
    expect(shape(assignClusters(inUi, 1).clusters)).toEqual([
      ['c:packages/ui', 'packages/ui', null],
      ['c:packages/ui/src', 'src', 'c:packages/ui'],
      ['c:packages/ui/src/a', 'a', 'c:packages/ui/src'],
      ['c:packages/ui/src/b', 'b', 'c:packages/ui/src'],
    ]);
    // A chain below the package is merged: `src` holds only `src/app`.
    const deep = filesIn('packages/ui/src/app/a', 20)
      .concat(filesIn('packages/ui/src/app/b', 20))
      .map((path) => ({ path, pkg: ui }));
    expect(shape(assignClusters(deep, 2).clusters)).toEqual([
      ['c:packages/ui', 'packages/ui', null],
      ['c:packages/ui/src/app', 'src/app', 'c:packages/ui'],
      ['c:packages/ui/src/app/a', 'a', 'c:packages/ui/src/app'],
      ['c:packages/ui/src/app/b', 'b', 'c:packages/ui/src/app'],
    ]);
  });

  it('is deterministic whatever the input order', () => {
    const input = plain([...app, 'src/main.ts', 'README.md']);
    const a = assignClusters(input, 2);
    const b = assignClusters([...input].reverse(), 2);
    expect(b.clusters).toEqual(a.clusters);
    expect([...b.clusterOf].sort()).toEqual([...a.clusterOf].sort());
    const ids = a.clusters.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
  });
});
