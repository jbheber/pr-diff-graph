import { describe, expect, it } from 'vitest';
import type { GraphCluster, GraphEdge, GraphJson, GraphNode } from '../../../src/graph/types.js';
import {
  buildCommentGraphs,
  mermaidLabel,
  renderGraphSections,
  type CommentGraphs,
} from '../../../src/publish/graphs.js';

interface NodeSpec {
  path: string;
  cluster: string;
  changed?: boolean;
  status?: GraphNode['status'];
}

/** A graph with only what `buildCommentGraphs` reads; clusters are `[id, parent]`. */
function graph(spec: {
  clusters: [string, string | null][];
  nodes: NodeSpec[];
  edges?: [string, string, boolean?][];
  ranking?: string[];
  cycles?: string[][];
}): GraphJson {
  const clusters: GraphCluster[] = spec.clusters.map(([id, parent]) => ({
    id,
    parent,
    label: parent ? id.slice(parent.length + 1) : id.slice(2),
  }));
  const nodes = spec.nodes.map((n) => {
    const changed = n.changed ?? true;
    return {
      id: n.path,
      path: n.path,
      cluster: n.cluster,
      changed,
      status: n.status ?? (changed ? 'modified' : 'unchanged'),
    } as GraphNode;
  });
  const changed = new Map(nodes.map((n) => [n.id, n.changed]));
  const edges = (spec.edges ?? []).map(([from, to, inCycle]): GraphEdge => ({
    from,
    to,
    kind: changed.get(from) && changed.get(to) ? 'changed-changed' : 'changed-unchanged',
    importKinds: ['static'],
    inCycle: inCycle ?? false,
  }));
  return {
    clusters,
    nodes,
    edges,
    ranking: spec.ranking ?? [],
    cycles: spec.cycles ?? [],
  } as unknown as GraphJson;
}

/** A box as the comment shows it, for readable assertions. */
const name = (b: CommentGraphs['boxes'][number]) =>
  b.kind === 'other' ? '(other)' : b.kind === 'own' ? `${b.label} (own files)` : b.label;

describe('buildCommentGraphs: overview boxes', () => {
  // big: 2 own files, big/x1 (8 sub-clusters, 1 file each), big/x2..x5 (1 file each)
  const clusters: [string, string | null][] = [
    ['c:big', null],
    ['c:big/x1', 'c:big'],
    ...Array.from({ length: 8 }, (_, i): [string, string] => [`c:big/x1/y${i}`, 'c:big/x1']),
    ...[2, 3, 4, 5].map((i): [string, string] => [`c:big/x${i}`, 'c:big']),
    ['c:small', null],
    ['c:quiet', null],
  ];
  const nodes: NodeSpec[] = [
    { path: 'big/own1.ts', cluster: 'c:big' },
    { path: 'big/own2.ts', cluster: 'c:big' },
    ...Array.from({ length: 8 }, (_, i) => ({
      path: `big/x1/y${i}/f.ts`,
      cluster: `c:big/x1/y${i}`,
    })),
    ...[2, 3, 4, 5].map((i) => ({ path: `big/x${i}/f.ts`, cluster: `c:big/x${i}` })),
    { path: 'big/x2/neighbor.ts', cluster: 'c:big/x2', changed: false },
    { path: 'small/s.ts', cluster: 'c:small' },
    { path: 'quiet/n.ts', cluster: 'c:quiet', changed: false },
  ];

  it('splits a dominant box past 12 and folds the smallest boxes into "other"', () => {
    const g = buildCommentGraphs(
      graph({ clusters, nodes, edges: [['small/s.ts', 'big/own1.ts']] }),
    )!;
    // big/x1 holds 8 of 15 changed files (> 25%), so it splits into 8 even though that makes
    // 14 boxes; the 3 smallest (1 file each, last by label) fold into one "other" box
    expect(g.boxes.map((b) => [name(b), b.files])).toEqual([
      ['big (own files)', 2],
      ...Array.from({ length: 8 }, (_, i) => [`big/x1/y${i}`, 1]),
      ['big/x2', 1],
      ['big/x3', 1],
      ['(other)', 3],
    ]);
    expect(g.boxes.find((b) => b.kind === 'other')?.label).toBe('');
    expect(g.boxes.filter((b) => b.kind === 'own').map((b) => b.label)).toEqual(['big']);
    // small/s.ts → big/own1.ts now runs from "other" to the own-files box
    expect(g.arrows).toEqual([{ from: 11, to: 0, count: 1, cycle: false }]);
  });

  it('merges arrows into the "other" box: counts add up, cycles OR, self-loops go', () => {
    const tops = Array.from({ length: 14 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    const g = buildCommentGraphs(
      graph({
        clusters: tops.map((t): [string, null] => [`c:${t}`, null]),
        nodes: tops.flatMap((t, i) =>
          Array.from({ length: i < 11 ? 2 : 1 }, (_, k) => ({
            path: `${t}/${k}.ts`,
            cluster: `c:${t}`,
          })),
        ),
        edges: [
          ['t11/0.ts', 't00/0.ts'],
          ['t12/0.ts', 't00/1.ts', true],
          ['t11/0.ts', 't12/0.ts', true],
          ['t00/0.ts', 't13/0.ts'],
          ['t01/0.ts', 't00/0.ts'],
        ],
      }),
    )!;
    expect(g.boxes).toHaveLength(12);
    expect(g.boxes.map(name)).toEqual([...tops.slice(0, 11), '(other)']);
    expect(g.boxes[11]!.files).toBe(3);
    expect(g.arrows).toEqual([
      { from: 11, to: 0, count: 2, cycle: true },
      { from: 0, to: 11, count: 1, cycle: false },
      { from: 1, to: 0, count: 1, cycle: false },
    ]);
  });

  it('splits down further when there is room', () => {
    const fewer = clusters.filter(([id]) => !/^c:big\/x1\/y[3-7]$/.test(id));
    const fewerNodes = nodes.filter((n) => !/^big\/x1\/y[3-7]\//.test(n.path));
    const g = buildCommentGraphs(
      graph({
        clusters: fewer,
        nodes: fewerNodes,
        edges: [['small/s.ts', 'big/own1.ts']],
      }),
    )!;
    expect(g.boxes.map(name).sort()).toEqual([
      'big (own files)',
      'big/x1/y0',
      'big/x1/y1',
      'big/x1/y2',
      'big/x2',
      'big/x3',
      'big/x4',
      'big/x5',
      'small',
    ]);
  });

  it('does not count or draw unchanged neighbors', () => {
    const g = buildCommentGraphs(
      graph({
        clusters,
        nodes,
        edges: [
          ['small/s.ts', 'big/own1.ts'],
          ['small/s.ts', 'quiet/n.ts'],
        ],
      }),
    )!;
    expect(g.boxes.find((b) => b.label === 'big/x2')?.files).toBe(1);
    expect(g.boxes.reduce((sum, b) => sum + b.files, 0)).toBe(15);
    expect(g.boxes.some((b) => b.label.startsWith('quiet'))).toBe(false);
    expect(g.arrows).toHaveLength(1);
  });

  it('aggregates arrows, drops self-loops and marks cycle arrows', () => {
    const g = buildCommentGraphs(
      graph({
        clusters: [
          ['c:a', null],
          ['c:b', null],
        ],
        nodes: [
          { path: 'a/1.ts', cluster: 'c:a' },
          { path: 'a/2.ts', cluster: 'c:a' },
          { path: 'b/1.ts', cluster: 'c:b' },
        ],
        edges: [
          ['a/1.ts', 'b/1.ts'],
          ['a/2.ts', 'b/1.ts', true],
          ['a/1.ts', 'a/2.ts'],
          ['b/1.ts', 'a/1.ts'],
        ],
      }),
    )!;
    const a = g.boxes.findIndex((b) => b.label === 'a');
    const b = g.boxes.findIndex((x) => x.label === 'b');
    expect(g.arrows).toEqual([
      { from: a, to: b, count: 2, cycle: true },
      { from: b, to: a, count: 1, cycle: false },
    ]);
  });

  it('keeps the 30 heaviest arrows', () => {
    const tops = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const edges: [string, string][] = [];
    tops.forEach((x, i) =>
      tops.forEach((y, j) => {
        if (i === j) return;
        // the pair (i, j) carries (i + j) % 7 + 1 imports
        for (let k = 0; k < ((i + j) % 7) + 1; k++) edges.push([`${x}/${k}.ts`, `${y}/0.ts`]);
      }),
    );
    const g = buildCommentGraphs(
      graph({
        clusters: tops.map((t): [string, null] => [`c:${t}`, null]),
        nodes: tops.flatMap((t) =>
          Array.from({ length: 7 }, (_, k) => ({ path: `${t}/${k}.ts`, cluster: `c:${t}` })),
        ),
        edges,
      }),
    )!;
    expect(g.boxes).toHaveLength(12);
    expect(g.arrows).toHaveLength(30);
    const counts = g.arrows.map((a) => a.count);
    expect(counts).toEqual([...counts].sort((x, y) => y - x));
    expect(counts[0]).toBe(7);
    expect(g.arrows.every((a) => a.from !== a.to)).toBe(true);
  });
});

describe('buildCommentGraphs: focus set', () => {
  const files = Array.from({ length: 40 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
  const nodes = files.map((path) => ({ path, cluster: 'c:src' }));

  it('takes the top 10 plus cycle members, capped at 25 nodes', () => {
    const g = buildCommentGraphs(
      graph({
        clusters: [['c:src', null]],
        nodes,
        ranking: files.slice(0, 10),
        cycles: [files.slice(5, 15), files.slice(20, 40)],
        edges: [[files[0]!, files[1]!]],
      }),
    )!;
    expect(g.nodes).toHaveLength(25);
    expect(g.nodes.slice(0, 10).map((n) => n.path)).toEqual(files.slice(0, 10));
    expect(g.nodes.slice(10, 15).map((n) => n.path)).toEqual(files.slice(10, 15));
    expect(g.nodes.slice(15).map((n) => n.path)).toEqual(files.slice(20, 30));
    expect(g.nodes[0]!.status).toBe('modified');
  });

  it('keeps only edges among the set, at most 60, cycle edges first', () => {
    const edges: [string, string, boolean?][] = [];
    for (let i = 0; i < 10; i++)
      for (let j = 0; j < 10; j++) if (i !== j) edges.push([files[i]!, files[j]!]);
    edges.push([files[0]!, files[30]!]);
    edges.push([files[9]!, files[8]!, true]);
    const g = buildCommentGraphs(
      graph({ clusters: [['c:src', null]], nodes, ranking: files.slice(0, 10), edges }),
    )!;
    expect(g.nodes).toHaveLength(10);
    expect(g.edges).toHaveLength(60);
    expect(g.edges[0]).toEqual({ from: 9, to: 8, cycle: true });
    expect(g.edges.every((e) => e.from < 10 && e.to < 10)).toBe(true);
  });

  it('returns null when there is nothing to draw', () => {
    expect(
      buildCommentGraphs(graph({ clusters: [['c:src', null]], nodes, ranking: files.slice(0, 3) })),
    ).toBeNull();
  });
});

const ALLOWED = /^"[A-Za-z0-9._/@+\- …]*"$/;

describe('mermaidLabel', () => {
  const hostile = [
    'src/```\n```html\n<script>.ts',
    'src/a"]-->X["b.ts',
    'src/<img src=x onerror=alert(1)>.ts',
    '%%{init: {"theme": "dark"}}%%',
    'a\nb.ts',
    'a\r\nflowchart TD',
    'src/#35;x.ts',
    'src/a;b.ts',
    `src/a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x2066)}.ts`,
    "src/{x}|y|&amp;'z'.ts",
    'src/[x](http://e).ts',
  ];

  it.each(hostile)('keeps only allowed characters: %j', (path) => {
    const out = mermaidLabel(path);
    expect(out).toMatch(ALLOWED);
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it('turns every other character into _', () => {
    expect(mermaidLabel('src/a"]b.ts')).toBe('"src/a__b.ts"');
    expect(mermaidLabel('@scope/pkg-a+b_c.ts')).toBe('"@scope/pkg-a+b_c.ts"');
  });

  it('keeps the end of a long path', () => {
    const out = mermaidLabel('very/long/directory/name/'.repeat(5) + 'the-file-name.tsx');
    expect(out.length).toBe(50);
    expect(out.startsWith('"…')).toBe(true);
    expect(out.endsWith('the-file-name.tsx"')).toBe(true);
  });
});

const sample: CommentGraphs = {
  boxes: [
    { label: 'src/app', files: 3, kind: 'dir' },
    { label: 'src/lib', files: 1, kind: 'own' },
    { label: 'src/`evil`', files: 2, kind: 'dir' },
    { label: '', files: 5, kind: 'other' },
  ],
  arrows: [
    { from: 0, to: 1, count: 4, cycle: false },
    { from: 1, to: 2, count: 1, cycle: true },
    { from: 3, to: 0, count: 2, cycle: false },
  ],
  nodes: [
    { path: 'src/app/a.ts', status: 'added' },
    { path: 'src/app/b.ts', status: 'modified' },
    { path: 'src/lib/c.ts', status: 'deleted' },
    { path: 'src/lib/d.ts', status: 'renamed' },
  ],
  edges: [
    { from: 0, to: 1, cycle: false },
    { from: 1, to: 2, cycle: false },
    { from: 2, to: 3, cycle: true },
  ],
};

describe('renderGraphSections', () => {
  it('emits two collapsible Mermaid sections', () => {
    const md = renderGraphSections(sample);
    expect(md.match(/<details>/g)).toHaveLength(2);
    expect(md.match(/```mermaid\nflowchart LR\n/g)).toHaveLength(2);
    // GitHub needs a blank line between </summary> and the fence
    expect(md).toMatch(/<\/summary>\n\n```mermaid/);
    expect(md).toContain('b0["src/app · 3 files"]');
    expect(md).toContain('b1["src/lib (own files) · 1 file"]');
    expect(md).toContain('b2["src/_evil_ · 2 files"]');
    expect(md).toContain('b3["other directories · 5 files"]');
    expect(md).toContain('b3 -->|2| b0');
    expect(md).toContain('b0 -->|4| b1');
    expect(md).toContain('b1 -->|1| b2');
    expect(md).toContain('linkStyle 1 stroke:#d1242f,stroke-width:2px');
    expect(md).toContain('linkStyle 2 stroke:#d1242f,stroke-width:2px');
    for (const s of ['added', 'modified', 'deleted', 'renamed']) {
      expect(md).toMatch(new RegExp(`classDef ${s} `));
    }
    expect(md).toContain('class f0 added');
    expect(md).toContain('f2 --> f3');
  });

  it('keeps repo text out of the <summary> lines', () => {
    const md = renderGraphSections(sample);
    for (const line of md.split('\n').filter((l) => l.includes('<summary>'))) {
      expect(line).not.toContain('src');
    }
  });

  it('leaves out a section with nothing to show', () => {
    const noOverview = renderGraphSections({ ...sample, arrows: [] });
    expect(noOverview.match(/<details>/g)).toHaveLength(1);
    expect(noOverview).not.toContain('b0');
    const oneBox = renderGraphSections({ ...sample, boxes: sample.boxes.slice(0, 1), arrows: [] });
    expect(oneBox).not.toContain('b0');
    const noFocus = renderGraphSections({ ...sample, edges: [] });
    expect(noFocus.match(/<details>/g)).toHaveLength(1);
    expect(noFocus).not.toContain('f0');
    expect(renderGraphSections({ boxes: [], arrows: [], nodes: [], edges: [] })).toBe('');
  });
});
