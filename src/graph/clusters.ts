import type { WorkspacePackage } from '../repo/index.js';
import { dirOf } from '../repo/paths.js';
import type { GraphCluster } from './types.js';

const ROOT = 'c:.';

function collapse(dir: string, depth: number): string {
  return dir.split('/').slice(0, Math.max(depth, 1)).join('/');
}

/**
 * The clusters `path` belongs to, outermost first; the last one is the node's cluster.
 *
 * - In a workspace package: the package (`c:packages/ui`), then, when `depth` ≥ 2 and the
 *   file is below the package root, its directory inside the package collapsed to
 *   `depth - 1` segments (`c:packages/ui/src`).
 * - Elsewhere: its directory collapsed to `depth` segments (`c:services/go`); root files
 *   go to `c:.`.
 */
export function clusterFor(path: string, pkg: WorkspacePackage | null, depth: number): string[] {
  const dir = dirOf(path);
  if (pkg && pkg.dir !== '') {
    const outer = `c:${pkg.dir}`;
    const inner = dir === pkg.dir ? '' : dir.slice(pkg.dir.length + 1);
    if (depth < 2 || inner === '') return [outer];
    return [outer, `c:${pkg.dir}/${collapse(inner, depth - 1)}`];
  }
  return dir === '' ? [ROOT] : [`c:${collapse(dir, depth)}`];
}

/** Every cluster named in `chains` once, with its parent (the previous chain entry), by id. */
export function clusterList(chains: Iterable<string[]>): GraphCluster[] {
  const clusters = new Map<string, GraphCluster>();
  for (const chain of chains) {
    chain.forEach((id, i) => {
      if (!clusters.has(id)) {
        clusters.set(id, { id, label: id.slice(2), parent: i > 0 ? chain[i - 1]! : null });
      }
    });
  }
  return [...clusters.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
