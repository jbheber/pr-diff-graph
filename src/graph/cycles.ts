/**
 * Cycles of a directed graph (Tarjan's SCC, iterative so long chains cannot overflow the
 * stack): every strongly connected component of more than one node, plus self-loops.
 * Each cycle's members are sorted, and the list is sorted by first member.
 */
export function findCycles(nodes: string[], edges: Array<[string, string]>): string[][] {
  const adj = new Map<string, string[]>();
  const selfLoops = new Set<string>();
  for (const n of nodes) adj.set(n, []);
  for (const [from, to] of edges) {
    if (from === to) selfLoops.add(from);
    adj.get(from)?.push(to);
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let next = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    // Each frame: node and the position of the next neighbor to visit.
    const frames: Array<{ node: string; i: number }> = [{ node: root, i: 0 }];
    index.set(root, next);
    low.set(root, next++);
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i++]!;
        if (!adj.has(w)) continue;
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next++);
          stack.push(w);
          onStack.add(w);
          frames.push({ node: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
        }
        continue;
      }

      frames.pop();
      const v = frame.node;
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(v)!));
      if (low.get(v) !== index.get(v)) continue;

      const component: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      if (component.length > 1 || selfLoops.has(v)) cycles.push(component.sort(compare));
    }
  }

  return cycles.sort((a, b) => compare(a[0]!, b[0]!));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
