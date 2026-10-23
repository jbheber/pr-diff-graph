import { describe, expect, it } from 'vitest';
import { clusterFor, clusterList } from '../../../src/graph/clusters.js';
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

describe('clusterList', () => {
  it('lists every cluster once with its parent, sorted', () => {
    expect(
      clusterList([['c:packages/ui', 'c:packages/ui/src'], ['c:packages/ui'], ['c:.']]),
    ).toEqual([
      { id: 'c:.', label: '.', parent: null },
      { id: 'c:packages/ui', label: 'packages/ui', parent: null },
      { id: 'c:packages/ui/src', label: 'packages/ui/src', parent: 'c:packages/ui' },
    ]);
  });
});
