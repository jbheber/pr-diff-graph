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

/** A cluster whose subtree holds more nodes than this splits by subdirectory. */
export const MAX_CLUSTER_FILES = 30;

export interface ClusterInput {
  path: string;
  pkg: WorkspacePackage | null;
}

interface Draft {
  id: string;
  /** The directory the cluster stands for (`''` for `c:.`). */
  dir: string;
  parent: Draft | null;
  isPackage: boolean;
  /** Paths placed directly in this cluster. */
  files: string[];
  children: Set<Draft>;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function subtreeSize(c: Draft): number {
  let n = c.files.length;
  for (const child of c.children) n += subtreeSize(child);
  return n;
}

/**
 * Nested directory clusters for `files` (every node of the graph, neighbors included):
 *
 * 1. Each file starts in its {@link clusterFor} chain (workspace package outermost, then the
 *    directory cut at `depth`).
 * 2. A cluster whose subtree holds more than {@link MAX_CLUSTER_FILES} nodes splits: each
 *    immediate subdirectory holding files becomes a child cluster; files directly in the
 *    directory stay. Applied recursively.
 * 3. A cluster holding exactly one child cluster and no files of its own is merged into that
 *    child (workspace packages are never merged away).
 *
 * Labels are the directory relative to the parent cluster's (the full path at the top), so a
 * merged chain shows its joined path (`src/app/modules`). Ids stay `c:<dir>`; the list is
 * sorted by id.
 */
export function assignClusters(
  files: Iterable<ClusterInput>,
  depth: number,
): { clusterOf: Map<string, string>; clusters: GraphCluster[] } {
  const drafts = new Map<string, Draft>();
  const draft = (id: string, parent: Draft | null, isPackage: boolean): Draft => {
    let d = drafts.get(id);
    if (!d) {
      d = {
        id,
        dir: id === ROOT ? '' : id.slice(2),
        parent,
        isPackage,
        files: [],
        children: new Set(),
      };
      drafts.set(id, d);
      parent?.children.add(d);
    }
    return d;
  };

  for (const { path, pkg } of [...files].sort((a, b) => compare(a.path, b.path))) {
    const chain = clusterFor(path, pkg, depth);
    let parent: Draft | null = null;
    chain.forEach((id, i) => {
      parent = draft(id, parent, i === 0 && pkg !== null && pkg.dir !== '');
    });
    parent!.files.push(path);
  }

  const split = (c: Draft) => {
    if (subtreeSize(c) > MAX_CLUSTER_FILES) {
      const own: string[] = [];
      for (const path of c.files) {
        const dir = dirOf(path);
        if (dir === c.dir) {
          own.push(path);
          continue;
        }
        const rest = c.dir === '' ? dir : dir.slice(c.dir.length + 1);
        const sub = rest.slice(0, rest.indexOf('/') < 0 ? rest.length : rest.indexOf('/'));
        const childDir = c.dir === '' ? sub : `${c.dir}/${sub}`;
        draft(`c:${childDir}`, c, false).files.push(path);
      }
      c.files = own;
    }
    for (const child of c.children) split(child);
  };
  const roots = [...drafts.values()].filter((d) => d.parent === null);
  for (const root of roots) split(root);

  for (const c of [...drafts.values()].sort((a, b) => compare(a.id, b.id))) {
    if (c.isPackage || c.files.length > 0 || c.children.size !== 1) continue;
    const [child] = c.children;
    child!.parent = c.parent;
    if (c.parent) {
      c.parent.children.delete(c);
      c.parent.children.add(child!);
    }
    drafts.delete(c.id);
  }

  const clusterOf = new Map<string, string>();
  const clusters: GraphCluster[] = [];
  for (const c of [...drafts.values()].sort((a, b) => compare(a.id, b.id))) {
    for (const path of c.files) clusterOf.set(path, c.id);
    const label = !c.parent
      ? c.dir || '.'
      : c.parent.dir === ''
        ? c.dir
        : c.dir.slice(c.parent.dir.length + 1);
    clusters.push({ id: c.id, label, parent: c.parent?.id ?? null });
  }
  return { clusterOf, clusters };
}
