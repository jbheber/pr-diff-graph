import { describe, expect, it } from 'vitest';
import { findCycles } from '../../../src/graph/cycles.js';

describe('findCycles', () => {
  it('finds a 3-cycle', () => {
    const edges: Array<[string, string]> = [
      ['c', 'a'],
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ];
    expect(findCycles(['a', 'b', 'c', 'd'], edges)).toEqual([['a', 'b', 'c']]);
  });

  it('finds a self-loop', () => {
    expect(
      findCycles(
        ['a', 'b'],
        [
          ['a', 'a'],
          ['a', 'b'],
        ],
      ),
    ).toEqual([['a']]);
  });

  it('two disjoint cycles', () => {
    const edges: Array<[string, string]> = [
      ['z', 'y'],
      ['y', 'z'],
      ['b', 'a'],
      ['a', 'b'],
      ['a', 'y'],
    ];
    expect(findCycles(['a', 'b', 'y', 'z'], edges)).toEqual([
      ['a', 'b'],
      ['y', 'z'],
    ]);
  });

  it('DAG has none', () => {
    const edges: Array<[string, string]> = [
      ['a', 'b'],
      ['b', 'c'],
      ['a', 'c'],
    ];
    expect(findCycles(['a', 'b', 'c'], edges)).toEqual([]);
  });

  it('handles a long chain without recursion limits', () => {
    const nodes = Array.from({ length: 50_000 }, (_, i) => `n${i}`);
    const edges = nodes.map((n, i): [string, string] => [n, nodes[(i + 1) % nodes.length]!]);
    const cycles = findCycles(nodes, edges);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(50_000);
  });
});
