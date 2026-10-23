import { describe, expect, it } from 'vitest';
import { rankNodes } from '../../../src/graph/rank.js';
import type { EdgeKind, GraphEdge, GraphNode } from '../../../src/graph/types.js';

function node(id: string, lines = 0, changed = true): GraphNode {
  return {
    id,
    path: id,
    oldPath: null,
    status: changed ? 'modified' : 'unchanged',
    changed,
    language: 'typescript',
    cluster: 'c:.',
    additions: lines,
    deletions: 0,
    binary: false,
    parseError: null,
    diffRef: changed ? 0 : null,
  };
}

function edge(from: string, to: string, kind: EdgeKind = 'changed-changed'): GraphEdge {
  return { from, to, kind, importKinds: ['static'], inCycle: false };
}

describe('rankNodes', () => {
  it('orders by changed-degree then lines changed', () => {
    const nodes = [node('a', 1), node('b', 5), node('c', 100), node('d', 3), node('u', 0, false)];
    const edges = [
      edge('a', 'b'),
      edge('d', 'b'),
      edge('a', 'd'),
      edge('c', 'u', 'changed-unchanged'),
      edge('u', 'c', 'unchanged-changed'),
    ];
    // degrees among changed files: a 2, b 2, d 2, c 0 → ties by lines: b 5, d 3, a 1
    expect(rankNodes(nodes, edges)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('caps at 10', () => {
    const nodes = Array.from({ length: 15 }, (_, i) => node(`f${String(i).padStart(2, '0')}`, i));
    expect(rankNodes(nodes, [])).toEqual([
      'f14',
      'f13',
      'f12',
      'f11',
      'f10',
      'f09',
      'f08',
      'f07',
      'f06',
      'f05',
    ]);
    expect(rankNodes(nodes, [], 3)).toHaveLength(3);
  });
});
