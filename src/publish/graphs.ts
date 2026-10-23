import type { ChangeStatus } from '../diff/collect.js';
import type { GraphJson, GraphNode } from '../graph/types.js';

/**
 * The two small graphs of the sticky comment, as structured data only. In `mode: comment` this
 * comes from a fork's `summary.json`, so it is schema-checked there (`parseSummaryJson`) and the
 * Mermaid text is generated from it here: node ids are generated and every label passes
 * {@link mermaidLabel}.
 */
export interface CommentGraphs {
  /**
   * Overview: directory clusters and how many changed files each holds. `dir` is a cluster's
   * whole subtree, `own` only the files directly in a cluster that was split, `other` the
   * smallest boxes folded together (its label is empty; the renderer writes fixed text).
   */
  boxes: { label: string; files: number; kind: BoxKind }[];
  /** Overview: changed→changed imports between two boxes (indexes into `boxes`). */
  arrows: { from: number; to: number; count: number; cycle: boolean }[];
  /** Focus: the most connected files and the files in cycles. */
  nodes: { path: string; status: ChangeStatus }[];
  /** Focus: changed→changed imports among `nodes` (indexes into `nodes`). */
  edges: { from: number; to: number; cycle: boolean }[];
}

export const BOX_KINDS = ['dir', 'own', 'other'] as const;
export type BoxKind = (typeof BOX_KINDS)[number];

export const MAX_BOXES = 12;
/** A box with more than this share of the changed files is split even past `MAX_BOXES`. */
export const DOMINANT_SHARE = 0.25;
export const MAX_ARROWS = 30;
export const FOCUS_TOP = 10;
export const MAX_NODES = 25;
export const MAX_EDGES = 60;
export const MAX_LABEL = 48;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A box while the tree is being cut: a cluster's whole subtree, or only its own files. */
interface Cut {
  cluster: string;
  own: boolean;
  files: number;
}

/** The full directory of a cluster id (`c:<dir>`). */
const dirOf = (clusterId: string) => clusterId.slice(2);

/**
 * Cuts the cluster tree into boxes: start at the top-level clusters, then keep splitting the
 * box with the most changed files (among those with child clusters) into its children, plus
 * an "own files" box for its own files, while the split stays within {@link MAX_BOXES} or the
 * box holds more than {@link DOMINANT_SHARE} of all changed files. Only changed files count;
 * clusters holding none get no box. May return more than {@link MAX_BOXES}; `overview` folds.
 */
function cutBoxes(graph: GraphJson, changed: GraphNode[]): Cut[] {
  const parent = new Map(graph.clusters.map((c) => [c.id, c.parent]));
  const children = new Map<string, string[]>();
  for (const c of graph.clusters) {
    if (c.parent) children.set(c.parent, [...(children.get(c.parent) ?? []), c.id]);
  }
  const own = new Map<string, number>();
  const subtree = new Map<string, number>();
  for (const n of changed) {
    own.set(n.cluster, (own.get(n.cluster) ?? 0) + 1);
    for (let c: string | null | undefined = n.cluster; c; c = parent.get(c)) {
      subtree.set(c, (subtree.get(c) ?? 0) + 1);
    }
  }
  const whole = (id: string): Cut => ({ cluster: id, own: false, files: subtree.get(id) ?? 0 });
  const busy = (ids: string[]) => ids.filter((id) => (subtree.get(id) ?? 0) > 0);
  const kids = (id: string) => busy(children.get(id) ?? []);

  let boxes = busy(graph.clusters.filter((c) => c.parent === null).map((c) => c.id)).map(whole);
  for (;;) {
    const next = boxes
      .filter((b) => !b.own && kids(b.cluster).length > 0)
      .sort((a, b) => b.files - a.files || compare(a.cluster, b.cluster))[0];
    if (!next) break;
    const ownFiles = own.get(next.cluster) ?? 0;
    const parts = kids(next.cluster).map(whole);
    if (ownFiles > 0) parts.unshift({ cluster: next.cluster, own: true, files: ownFiles });
    const fits = boxes.length - 1 + parts.length <= MAX_BOXES;
    if (!fits && next.files <= DOMINANT_SHARE * changed.length) break;
    boxes = boxes.flatMap((b) => (b === next ? parts : [b]));
  }
  return boxes;
}

function overview(graph: GraphJson, changed: GraphNode[]): Pick<CommentGraphs, 'boxes' | 'arrows'> {
  const cut = cutBoxes(graph, changed);
  const parent = new Map(graph.clusters.map((c) => [c.id, c.parent]));
  const whole = new Map<string, Cut>();
  const own = new Map<string, Cut>();
  for (const b of cut) (b.own ? own : whole).set(b.cluster, b);
  const cutOf = (n: GraphNode): Cut | undefined => {
    if (own.has(n.cluster)) return own.get(n.cluster);
    for (let c: string | null | undefined = n.cluster; c; c = parent.get(c)) {
      if (whole.has(c)) return whole.get(c);
    }
    return undefined;
  };

  // Over the cap: keep the largest boxes (ties by path) and fold the rest into "other".
  const byPath = (a: Cut, b: Cut) =>
    compare(dirOf(a.cluster), dirOf(b.cluster)) || Number(b.own) - Number(a.own);
  let kept = cut;
  let folded: Cut[] = [];
  if (cut.length > MAX_BOXES) {
    const bySize = [...cut].sort((a, b) => b.files - a.files || byPath(a, b));
    kept = bySize.slice(0, MAX_BOXES - 1);
    folded = bySize.slice(MAX_BOXES - 1);
  }
  kept = [...kept].sort(byPath);
  const boxes: CommentGraphs['boxes'] = kept.map((b) => ({
    label: dirOf(b.cluster),
    files: b.files,
    kind: b.own ? 'own' : 'dir',
  }));
  const indexOf = new Map<Cut, number>(kept.map((b, i) => [b, i]));
  if (folded.length > 0) {
    for (const b of folded) indexOf.set(b, boxes.length);
    boxes.push({ label: '', files: folded.reduce((sum, b) => sum + b.files, 0), kind: 'other' });
  }

  const box = new Map<string, number>();
  for (const n of changed) {
    const c = cutOf(n);
    const i = c ? indexOf.get(c) : undefined;
    if (i !== undefined) box.set(n.id, i);
  }
  const arrows = new Map<string, CommentGraphs['arrows'][number]>();
  for (const e of graph.edges) {
    if (e.kind !== 'changed-changed') continue;
    const from = box.get(e.from);
    const to = box.get(e.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}>${to}`;
    const a = arrows.get(key) ?? { from, to, count: 0, cycle: false };
    a.count++;
    a.cycle ||= e.inCycle;
    arrows.set(key, a);
  }
  return {
    boxes,
    arrows: [...arrows.values()]
      // Cycle arrows first, so the cap never drops a red one.
      .sort(
        (a, b) =>
          Number(b.cycle) - Number(a.cycle) || b.count - a.count || a.from - b.from || a.to - b.to,
      )
      .slice(0, MAX_ARROWS),
  };
}

function focus(graph: GraphJson, changed: GraphNode[]): Pick<CommentGraphs, 'nodes' | 'edges'> {
  const byId = new Map(changed.map((n) => [n.id, n]));
  const index = new Map<string, number>();
  const nodes: CommentGraphs['nodes'] = [];
  const add = (id: string) => {
    const n = byId.get(id);
    if (!n || index.has(id) || nodes.length >= MAX_NODES || n.status === 'unchanged') return;
    index.set(id, nodes.length);
    nodes.push({ path: n.path, status: n.status });
  };
  graph.ranking.slice(0, FOCUS_TOP).forEach(add);
  graph.cycles.flat().forEach(add);

  const edges: CommentGraphs['edges'] = [];
  for (const e of graph.edges) {
    const from = index.get(e.from);
    const to = index.get(e.to);
    if (e.kind !== 'changed-changed' || from === undefined || to === undefined) continue;
    edges.push({ from, to, cycle: e.inCycle });
  }
  // Cycle edges first so the cap never drops them; otherwise the graph's order.
  edges.sort((a, b) => Number(b.cycle) - Number(a.cycle));
  return { nodes, edges: edges.slice(0, MAX_EDGES) };
}

const hasOverview = (g: CommentGraphs) => g.boxes.length >= 2 && g.arrows.length >= 1;
const hasFocus = (g: CommentGraphs) => g.edges.length >= 1;

/** The comment's graphs for `graph`, or null when neither would show anything. */
export function buildCommentGraphs(graph: GraphJson): CommentGraphs | null {
  const changed = graph.nodes.filter((n) => n.changed);
  const g = { ...overview(graph, changed), ...focus(graph, changed) };
  return hasOverview(g) || hasFocus(g) ? g : null;
}

/**
 * A repo path as a quoted Mermaid label: the last {@link MAX_LABEL} characters (an ellipsis
 * marks the cut), and only `A-Z a-z 0-9 . _ / @ + -` and space kept; every other character
 * becomes `_`. Nothing in the result can close the quote, start HTML, markdown or a Mermaid
 * directive, or leave the code fence. `suffix` is appended inside the quotes and must be fixed
 * text, never repo data.
 */
export function mermaidLabel(s: string, suffix = ''): string {
  const chars = [...s];
  const cut =
    chars.length <= MAX_LABEL ? s : '…' + chars.slice(chars.length - (MAX_LABEL - 1)).join('');
  const safe = cut.replace(/[^A-Za-z0-9._/@+\- …]/gu, '_');
  return `"${safe}${suffix}"`;
}

const RED = 'stroke:#d1242f,stroke-width:2px';

/** GitHub's diff colours, as fill / border / text. */
const STATUS_STYLE: Record<ChangeStatus, string> = {
  added: 'fill:#dafbe1,stroke:#1a7f37,color:#0d3a1a',
  modified: 'fill:#fff8c5,stroke:#9a6700,color:#4d2d00',
  deleted: 'fill:#ffebe9,stroke:#cf222e,color:#5c0f13',
  renamed: 'fill:#ddf4ff,stroke:#0969da,color:#0a3069',
};

const fmt = (x: number) => x.toLocaleString('en-US');

/** A collapsible section; `summary` is fixed text, never repo data. */
function section(summary: string, lines: string[]): string {
  return [
    '<details>',
    `<summary>${summary}</summary>`,
    '',
    '```mermaid',
    'flowchart LR',
    ...lines.map((l) => `  ${l}`),
    '```',
    '',
    '</details>',
  ].join('\n');
}

const redLinks = (cycle: boolean[]) =>
  cycle.flatMap((c, i) => (c ? [`linkStyle ${i} ${RED}`] : []));

function overviewSection(g: CommentGraphs): string {
  const lines = g.boxes.map((b, i) => {
    const files = `${fmt(b.files)} ${b.files === 1 ? 'file' : 'files'}`;
    // Fixed text only: an "other" box has no repo label; "(own files)" is not from the data.
    if (b.kind === 'other') return `b${i}["other directories · ${files}"]`;
    const suffix = `${b.kind === 'own' ? ' (own files)' : ''} · ${files}`;
    return `b${i}[${mermaidLabel(b.label, suffix)}]`;
  });
  for (const a of g.arrows) lines.push(`b${a.from} -->|${fmt(a.count)}| b${a.to}`);
  lines.push(...redLinks(g.arrows.map((a) => a.cycle)));
  return section('Overview: how the changed directories depend on each other', lines);
}

function focusSection(g: CommentGraphs): string {
  const lines = g.nodes.map((n, i) => `f${i}[${mermaidLabel(n.path)}]`);
  for (const e of g.edges) lines.push(`f${e.from} --> f${e.to}`);
  lines.push(...redLinks(g.edges.map((e) => e.cycle)));
  for (const status of Object.keys(STATUS_STYLE) as ChangeStatus[]) {
    const ids = g.nodes.flatMap((n, i) => (n.status === status ? [`f${i}`] : []));
    if (ids.length === 0) continue;
    lines.push(`classDef ${status} ${STATUS_STYLE[status]}`, `class ${ids.join(',')} ${status}`);
  }
  return section('Focus: most connected files and cycles (red: import cycle)', lines);
}

/** The comment's graph sections (markdown), or `''` when neither has anything to show. */
export function renderGraphSections(g: CommentGraphs): string {
  const parts: string[] = [];
  if (hasOverview(g)) parts.push(overviewSection(g));
  if (hasFocus(g)) parts.push(focusSection(g));
  return parts.join('\n\n');
}
