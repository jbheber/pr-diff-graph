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
    } as unknown as GraphJson;
    const s = toCommentSummary(result({ filesChanged: 5, graph }), 50, 'a'.repeat(40));
    const back = parseSummaryJson(JSON.stringify(s));
    expect(back.top[0]).toHaveLength(300);
    expect(back.top[0]!.startsWith('\u2026')).toBe(true);
    expect(back.top[0]!.endsWith('file.ts')).toBe(true);
    expect(back.top[1]).toBe('short.ts');
    expect(back.files).toBe(10_000_000);
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
