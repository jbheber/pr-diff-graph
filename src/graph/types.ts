import type { ChangeStatus } from '../diff/collect.js';
import type { RawImport, Resolution } from '../parsers/types.js';

/** `unchanged` is only used by neighbor nodes (files the PR did not touch). */
export type NodeStatus = ChangeStatus | 'unchanged';

export type EdgeKind = 'changed-changed' | 'changed-unchanged' | 'unchanged-changed';

export interface GraphNode {
  /** The path at head; for deleted files the old path. */
  id: string;
  path: string;
  oldPath: string | null;
  status: NodeStatus;
  changed: boolean;
  language: string | null;
  /** The innermost cluster id. */
  cluster: string;
  additions: number;
  deletions: number;
  binary: boolean;
  parseError: string | null;
  /** Index into the diffs array; null for unchanged nodes. */
  diffRef: number | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  importKinds: RawImport['kind'][];
  inCycle: boolean;
}

export interface GraphCluster {
  id: string;
  label: string;
  parent: string | null;
}

export interface UnresolvedImport {
  from: string;
  specifier: string;
  line: number;
  reason: string;
}

export interface GraphSummary {
  files: number;
  additions: number;
  deletions: number;
  edges: number;
  cycles: number;
  unresolved: number;
  parseErrors: number;
  binary: number;
  /** Changed files before include/exclude filtering. */
  rawFiles: number;
  /** Distinct external module names imported by changed files. */
  externals: number;
}

export interface GraphJson {
  version: 1;
  pr: {
    number: number | null;
    base: string;
    head: string;
    mergeBase: string;
    repo: string | null;
  };
  summary: GraphSummary;
  clusters: GraphCluster[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  cycles: string[][];
  ranking: string[];
  unresolved: UnresolvedImport[];
}

export interface DiffEntry {
  path: string;
  patch: string | null;
  truncated: boolean;
  binary: boolean;
}

export interface ImportEntry {
  imp: RawImport;
  /** Resolved against the index the file was parsed at (head; merge base for deleted files). */
  res: Resolution;
  /**
   * For a head file's unresolved import only: the same import resolved at the merge base,
   * which tells a missing target apart from one this PR deleted.
   */
  baseRes?: Resolution;
}

export interface FileImports {
  language: string | null;
  parseError: string | null;
  imports: ImportEntry[];
}
