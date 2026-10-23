import { describe, expect, it } from 'vitest';
import type { GraphJson } from '../../../src/graph/types.js';
import type { PipelineResult } from '../../../src/pipeline.js';
import {
  parseSummaryJson,
  toCommentSummary,
  type CommentSummary,
} from '../../../src/publish/summary.js';

const valid: CommentSummary = {
  version: 1,
  skipped: false,
  minFiles: 50,
  files: 120,
  additions: 3000,
  deletions: 200,
  edges: 340,
  cycles: 2,
  unresolved: 4,
  parseErrors: 1,
  top: ['src/a.ts', 'src/b.ts'],
  headSha: 'a'.repeat(40),
};

function result(over: Partial<PipelineResult>): PipelineResult {
  return {
    skipped: false,
    filesChanged: 0,
    rawFilesChanged: 0,
    graph: null,
    reportPath: null,
    graphPath: null,
    summaryPath: null,
    ...over,
  };
}

describe('toCommentSummary', () => {
  it('takes the totals and the top 5 ranked files from the graph', () => {
    const graph = {
      summary: {
        files: 60,
        additions: 10,
        deletions: 5,
        edges: 70,
        cycles: 1,
        unresolved: 3,
        parseErrors: 2,
        binary: 0,
        rawFiles: 61,
        externals: 4,
      },
      ranking: ['a', 'b', 'c', 'd', 'e', 'f'],
      clusters: [],
      nodes: [],
      edges: [],
      cycles: [],
    } as unknown as GraphJson;
    expect(toCommentSummary(result({ filesChanged: 60, graph }), 50, 'abc')).toEqual({
      version: 1,
      skipped: false,
      minFiles: 50,
      files: 60,
      additions: 10,
      deletions: 5,
      edges: 70,
      cycles: 1,
      unresolved: 3,
      parseErrors: 2,
      top: ['a', 'b', 'c', 'd', 'e'],
      headSha: 'abc',
    });
  });

  it('round-trips through parseSummaryJson even with very long paths and huge counts', () => {
    const long = 'd/'.repeat(300) + 'file.ts';
    const graph = {
      summary: {
        files: 99_999_999,
        additions: 99_999_999,
        deletions: 99_999_999,
        edges: 99_999_999,
        cycles: 99_999_999,
        unresolved: 99_999_999,
        parseErrors: 99_999_999,
      },
      ranking: [long, 'short.ts'],
      clusters: [],
      nodes: [],
      edges: [],
      cycles: [],
    } as unknown as GraphJson;
    const s = toCommentSummary(result({ filesChanged: 5, graph }), 50, 'a'.repeat(40));
    const back = parseSummaryJson(JSON.stringify(s));
    expect(back.top[0]).toHaveLength(300);
    expect(back.top[0]!.startsWith('\u2026')).toBe(true);
    expect(back.top[0]!.endsWith('file.ts')).toBe(true);
    expect(back.top[1]).toBe('short.ts');
    expect(back.files).toBe(10_000_000);
  });

  it('adds graphs, clamping long labels and paths so the result still parses', () => {
    const long = 'd/'.repeat(300) + 'file.ts';
    const graph = {
      summary: { files: 3, additions: 0, deletions: 0, edges: 2 },
      clusters: [
        { id: 'c:a', label: 'a', parent: null },
        { id: `c:${long}`, label: long, parent: null },
      ],
      nodes: [
        { id: 'a/x.ts', path: 'a/x.ts', cluster: 'c:a', changed: true, status: 'added' },
        { id: 'a/y.ts', path: 'a/y.ts', cluster: 'c:a', changed: true, status: 'modified' },
        {
          id: `${long}/z.ts`,
          path: `${long}/z.ts`,
          cluster: `c:${long}`,
          changed: true,
          status: 'deleted',
        },
      ],
      edges: [
        {
          from: 'a/x.ts',
          to: `${long}/z.ts`,
          kind: 'changed-changed',
          importKinds: [],
          inCycle: false,
        },
        { from: 'a/x.ts', to: 'a/y.ts', kind: 'changed-changed', importKinds: [], inCycle: false },
      ],
      cycles: [],
      ranking: ['a/x.ts', 'a/y.ts', `${long}/z.ts`],
    } as unknown as GraphJson;
    const s = toCommentSummary(result({ filesChanged: 3, graph }), 0, 'a'.repeat(40));
    expect(s.graphs?.boxes).toHaveLength(2);
    expect(s.graphs?.nodes).toHaveLength(3);
    expect(parseSummaryJson(JSON.stringify(s))).toEqual(s);
  });

  it('leaves graphs out when there is nothing to draw', () => {
    const s = toCommentSummary(result({ skipped: true, filesChanged: 7 }), 50, 'abc');
    expect('graphs' in s).toBe(false);
  });

  it('skipped result: file count only', () => {
    const s = toCommentSummary(result({ skipped: true, filesChanged: 7 }), 50, 'abc');
    expect(s).toMatchObject({ skipped: true, files: 7, edges: 0, top: [] });
  });
});

describe('parseSummaryJson', () => {
  it('accepts a valid summary', () => {
    expect(parseSummaryJson(JSON.stringify(valid))).toEqual(valid);
  });

  it('rejects extra-large numbers, long paths, wrong version, non-JSON', () => {
    const bad = (over: Record<string, unknown>) => JSON.stringify({ ...valid, ...over });
    expect(() => parseSummaryJson(bad({ files: 10_000_001 }))).toThrow();
    expect(() => parseSummaryJson(bad({ edges: -1 }))).toThrow();
    expect(() => parseSummaryJson(bad({ cycles: 1.5 }))).toThrow();
    expect(() => parseSummaryJson(bad({ top: ['x'.repeat(301)] }))).toThrow();
    expect(() => parseSummaryJson(bad({ top: ['1', '2', '3', '4', '5', '6'] }))).toThrow();
    expect(() => parseSummaryJson(bad({ version: 2 }))).toThrow();
    expect(() => parseSummaryJson(bad({ prNumber: 1 }))).toThrow();
    expect(() => parseSummaryJson(bad({ headSha: 'not a sha' }))).toThrow();
    expect(() => parseSummaryJson('{not json')).toThrow(/summary\.json/);
    expect(() => parseSummaryJson('null')).toThrow(/summary\.json/);
  });
});

describe('parseSummaryJson: graphs', () => {
  const graphs = {
    boxes: [
      { label: 'src/a', files: 2, kind: 'own' },
      { label: 'src/b', files: 1, kind: 'dir' },
      { label: '', files: 4, kind: 'other' },
    ],
    arrows: [{ from: 0, to: 1, count: 3, cycle: true }],
    nodes: [
      { path: 'src/a/x.ts', status: 'added' },
      { path: 'src/b/y.ts', status: 'renamed' },
    ],
    edges: [{ from: 0, to: 1, cycle: false }],
  };
  const withGraphs = (g: unknown) => JSON.stringify({ ...valid, graphs: g });

  it('accepts valid graphs, and a summary without graphs', () => {
    expect(parseSummaryJson(withGraphs(graphs)).graphs).toEqual(graphs);
    expect(parseSummaryJson(JSON.stringify(valid)).graphs).toBeUndefined();
  });

  it('rejects out-of-range indexes', () => {
    const arrow = (a: object) => withGraphs({ ...graphs, arrows: [{ ...graphs.arrows[0], ...a }] });
    expect(() => parseSummaryJson(arrow({ to: 3 }))).toThrow(/graphs\.arrows\.0\.to/);
    expect(() => parseSummaryJson(arrow({ from: -1 }))).toThrow();
    expect(() => parseSummaryJson(arrow({ from: 0.5 }))).toThrow();
    const edge = withGraphs({ ...graphs, edges: [{ from: 0, to: 2, cycle: false }] });
    expect(() => parseSummaryJson(edge)).toThrow(/graphs\.edges\.0\.to/);
  });

  it('rejects too many items', () => {
    const boxes = Array.from({ length: 13 }, (_, i) => ({ label: `d${i}`, files: 1, kind: 'dir' }));
    expect(() => parseSummaryJson(withGraphs({ ...graphs, boxes }))).toThrow();
    const nodes = Array.from({ length: 26 }, (_, i) => ({ path: `f${i}`, status: 'added' }));
    expect(() => parseSummaryJson(withGraphs({ ...graphs, nodes }))).toThrow();
    const arrows = Array.from({ length: 31 }, () => graphs.arrows[0]);
    expect(() => parseSummaryJson(withGraphs({ ...graphs, arrows }))).toThrow();
    const edges = Array.from({ length: 61 }, () => graphs.edges[0]);
    expect(() => parseSummaryJson(withGraphs({ ...graphs, edges }))).toThrow();
  });

  it('rejects a bad status, long labels, bad counts and extra keys', () => {
    const node = (n: object) => withGraphs({ ...graphs, nodes: [{ ...graphs.nodes[0], ...n }] });
    expect(() => parseSummaryJson(node({ status: 'unchanged' }))).toThrow();
    expect(() => parseSummaryJson(node({ path: 'x'.repeat(301) }))).toThrow();
    expect(() => parseSummaryJson(node({ id: 'f0' }))).toThrow();
    const box = (b: object) =>
      withGraphs({ ...graphs, boxes: [{ ...graphs.boxes[0], ...b }, graphs.boxes[1]] });
    expect(() => parseSummaryJson(box({ label: 'x'.repeat(301) }))).toThrow();
    expect(() => parseSummaryJson(box({ kind: 'cluster' }))).toThrow();
    expect(() => parseSummaryJson(box({ kind: undefined }))).toThrow();
    expect(() => parseSummaryJson(box({ kind: 'other', label: 'src/a' }))).toThrow(
      /graphs\.boxes\.0\.label/,
    );
    expect(() => parseSummaryJson(box({ files: 10_000_001 }))).toThrow();
    expect(() => parseSummaryJson(box({ mermaid: 'graph TD' }))).toThrow();
    expect(() => parseSummaryJson(withGraphs({ ...graphs, mermaid: 'x' }))).toThrow();
    expect(() => parseSummaryJson(withGraphs('flowchart LR'))).toThrow();
  });
});
