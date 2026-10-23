import type { GraphEdge, GraphNode } from './types.js';

/**
 * "Review these first": the `n` changed files with the highest changed-degree (edges in and
 * out among changed files), ties broken by lines changed, then by path.
 */
export function rankNodes(nodes: GraphNode[], edges: GraphEdge[], n = 10): string[] {
  const degree = new Map<string, number>();
  for (const e of edges) {
    if (e.kind !== 'changed-changed') continue;
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const lines = (node: GraphNode) => node.additions + node.deletions;
  return nodes
    .filter((node) => node.changed)
    .sort(
      (a, b) =>
        (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
        lines(b) - lines(a) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, n)
    .map((node) => node.id);
}
