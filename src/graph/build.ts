import type { ChangedFile } from '../diff/collect.js';
import type { RawImport } from '../parsers/types.js';
import type { RepoIndex } from '../repo/index.js';
import { clusterFor, clusterList } from './clusters.js';
import { findCycles } from './cycles.js';
import { rankNodes } from './rank.js';
import type {
  DiffEntry,
  EdgeKind,
  FileImports,
  GraphEdge,
  GraphJson,
  GraphNode,
  UnresolvedImport,
} from './types.js';

export interface BuildGraphArgs {
  pr: GraphJson['pr'];
  /** The changed files after filtering. */
  files: ChangedFile[];
  /**
   * Parsed imports by path: changed files (deleted ones parsed at the merge base), plus
   * unchanged files — either language-only entries for outgoing neighbors or, with
   * scan-repo, parsed files whose imports may reach changed files.
   */
  imports: Map<string, FileImports>;
  headIndex: RepoIndex;
  baseIndex: RepoIndex;
  clusterDepth: number;
  rawFiles: number;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildGraph(args: BuildGraphArgs): { graph: GraphJson; diffs: DiffEntry[] } {
  const { imports, clusterDepth } = args;
  const files = [...args.files].sort((a, b) => compare(a.path, b.path));
  const changedIds = new Set(files.map((f) => f.path));
  /** Old path of a rename → its node, so base-parsed (deleted) files can point at it. */
  const renamedTo = new Map<string, string>();
  /** Paths that existed at the merge base and are gone at head. */
  const gone = new Set<string>();
  for (const f of files) {
    if (f.status === 'deleted') gone.add(f.path);
    if (f.status === 'renamed' && f.oldPath) {
      renamedTo.set(f.oldPath, f.path);
      gone.add(f.oldPath);
    }
  }

  const nodes = new Map<string, GraphNode>();
  const chains: string[][] = [];
  const diffs: DiffEntry[] = [];
  const clusterOf = (path: string, index: RepoIndex) => {
    const chain = clusterFor(path, index.packageOf(path), clusterDepth);
    chains.push(chain);
    return chain[chain.length - 1]!;
  };

  for (const f of files) {
    const entry = imports.get(f.path);
    const index = f.status === 'deleted' ? args.baseIndex : args.headIndex;
    nodes.set(f.path, {
      id: f.path,
      path: f.path,
      oldPath: f.oldPath,
      status: f.status,
      changed: true,
      language: entry?.language ?? null,
      cluster: clusterOf(f.path, index),
      additions: f.additions,
      deletions: f.deletions,
      binary: f.binary,
      parseError: entry?.parseError ?? null,
      diffRef: diffs.length,
    });
    diffs.push({ path: f.path, patch: f.patch, truncated: f.patchTruncated, binary: f.binary });
  }

  const addUnchanged = (path: string) => {
    if (nodes.has(path)) return;
    nodes.set(path, {
      id: path,
      path,
      oldPath: null,
      status: 'unchanged',
      changed: false,
      language: imports.get(path)?.language ?? null,
      cluster: clusterOf(path, args.headIndex),
      additions: 0,
      deletions: 0,
      binary: false,
      parseError: null,
      diffRef: null,
    });
  };

  const edges = new Map<string, { from: string; to: string; kind: EdgeKind; kinds: Set<string> }>();
  const addEdge = (from: string, to: string, kind: EdgeKind, importKind: RawImport['kind']) => {
    const key = `${from}\0${to}`;
    const edge = edges.get(key) ?? { from, to, kind, kinds: new Set<string>() };
    edge.kinds.add(importKind);
    edges.set(key, edge);
  };

  const unresolved: UnresolvedImport[] = [];
  const externals = new Set<string>();

  for (const f of files) {
    const entry = imports.get(f.path);
    if (!entry || entry.parseError) continue;
    const deleted = f.status === 'deleted';
    for (const { imp, res, baseRes } of entry.imports) {
      if (res.kind === 'external') {
        externals.add(res.name);
      } else if (res.kind === 'unresolved') {
        const targetDeleted =
          !deleted && baseRes?.kind === 'file' && baseRes.paths.some((p) => gone.has(p));
        unresolved.push({
          from: f.path,
          specifier: imp.specifier,
          line: imp.line,
          reason: targetDeleted ? 'target deleted' : res.reason,
        });
      } else {
        for (const p of res.paths) {
          const target = changedIds.has(p) ? p : deleted ? (renamedTo.get(p) ?? p) : p;
          if (changedIds.has(target)) {
            addEdge(f.path, target, 'changed-changed', imp.kind);
          } else {
            addUnchanged(target);
            addEdge(f.path, target, 'changed-unchanged', imp.kind);
          }
        }
      }
    }
  }

  // Unchanged importers (scan-repo): only their edges into changed files are drawn.
  for (const [path, entry] of imports) {
    if (changedIds.has(path) || entry.parseError) continue;
    for (const { imp, res } of entry.imports) {
      if (res.kind !== 'file') continue;
      for (const p of res.paths) {
        if (!changedIds.has(p) || gone.has(p)) continue;
        addUnchanged(path);
        addEdge(path, p, 'unchanged-changed', imp.kind);
      }
    }
  }

  const changedEdges = [...edges.values()]
    .filter((e) => e.kind === 'changed-changed')
    .map((e): [string, string] => [e.from, e.to]);
  const cycles = findCycles([...changedIds].sort(compare), changedEdges);
  const cycleOf = new Map<string, number>();
  cycles.forEach((members, i) => members.forEach((m) => cycleOf.set(m, i)));

  const edgeList: GraphEdge[] = [...edges.values()]
    .map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
      importKinds: [...e.kinds].sort(compare) as RawImport['kind'][],
      inCycle:
        e.kind === 'changed-changed' &&
        cycleOf.has(e.from) &&
        cycleOf.get(e.from) === cycleOf.get(e.to),
    }))
    .sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));

  const nodeList = [...nodes.values()].sort((a, b) => compare(a.id, b.id));
  unresolved.sort(
    (a, b) => compare(a.from, b.from) || a.line - b.line || compare(a.specifier, b.specifier),
  );
  const changedNodes = nodeList.filter((n) => n.changed);

  const graph: GraphJson = {
    version: 1,
    pr: args.pr,
    summary: {
      files: changedNodes.length,
      additions: changedNodes.reduce((s, n) => s + n.additions, 0),
      deletions: changedNodes.reduce((s, n) => s + n.deletions, 0),
      edges: edgeList.length,
      cycles: cycles.length,
      unresolved: unresolved.length,
      parseErrors: changedNodes.filter((n) => n.parseError !== null).length,
      binary: changedNodes.filter((n) => n.binary).length,
      rawFiles: args.rawFiles,
      externals: externals.size,
    },
    clusters: clusterList(chains),
    nodes: nodeList,
    edges: edgeList,
    cycles,
    ranking: rankNodes(nodeList, edgeList),
    unresolved,
  };
  return { graph, diffs };
}
