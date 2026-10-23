import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GraphJson } from '../../src/graph/types.js';
import { silentLogger } from '../../src/log.js';
import { grammarDir } from '../../src/parsers/treesitter.js';
import { runPipeline, type PipelineOptions, type PipelineResult } from '../../src/pipeline.js';
import { toCommentSummary } from '../../src/publish/summary.js';
import { makeMonorepo, type MonorepoFixture } from './fixture.js';

let fx: MonorepoFixture;
let out: string;

beforeAll(async () => {
  fx = await makeMonorepo();
  out = await mkdtemp(join(tmpdir(), 'pdg-out-'));
});

afterAll(async () => {
  await fx?.cleanup();
  if (out) await rm(out, { recursive: true, force: true });
});

function options(overrides: Partial<PipelineOptions>): PipelineOptions {
  return {
    repo: fx.dir,
    base: fx.base,
    head: fx.head,
    outDir: out,
    minFiles: 0,
    include: [],
    exclude: [],
    clusterDepth: 2,
    collapseThreshold: 150,
    scanRepo: false,
    maxPatchBytes: 200_000,
    prNumber: 42,
    repoSlug: 'acme/monorepo',
    log: silentLogger,
    grammarDir: grammarDir(),
    assetsDir: join(import.meta.dirname, '../../build/client'),
    ...overrides,
  };
}

/** The graph with the three commit SHAs replaced by placeholders. */
function normalized(graph: GraphJson): GraphJson {
  const text = JSON.stringify(graph)
    .replaceAll(fx.mergeBase, '<mb>')
    .replaceAll(fx.base, '<base>')
    .replaceAll(fx.head, '<head>');
  return JSON.parse(text) as GraphJson;
}

describe('runPipeline on the monorepo fixture', () => {
  let result: PipelineResult;
  let graph: GraphJson;

  beforeAll(async () => {
    result = await runPipeline(options({ outDir: join(out, 'full') }));
    graph = result.graph!;
  });

  it('matches the graph snapshot', () => {
    expect(result.skipped).toBe(false);
    expect(new Set([fx.base, fx.head, fx.mergeBase]).size).toBe(3);
    expect(graph.pr).toEqual({
      number: 42,
      base: fx.base,
      head: fx.head,
      mergeBase: fx.mergeBase,
      repo: 'acme/monorepo',
    });
    expect(normalized(graph)).toMatchSnapshot();
  });

  it('reports one cycle, one parse error and one binary file', () => {
    expect(graph.summary.cycles).toBe(1);
    expect(graph.cycles).toEqual([
      ['packages/web/src/cycle/a.ts', 'packages/web/src/cycle/b.ts', 'packages/web/src/cycle/c.ts'],
    ]);
    expect(graph.summary.parseErrors).toBe(1);
    expect(graph.nodes.find((n) => n.parseError)?.path).toBe('packages/web/src/broken.ts');
    expect(graph.summary.binary).toBe(1);
  });

  it('filters the lockfile out', () => {
    expect(graph.nodes.some((n) => n.path === 'package-lock.json')).toBe(false);
    expect(graph.summary.rawFiles).toBe(graph.summary.files + 1);
    expect(result.rawFilesChanged).toBe(result.filesChanged + 1);
  });

  it('flags the import of a deleted file', () => {
    expect(graph.unresolved).toContainEqual({
      from: 'packages/web/src/uses-legacy.ts',
      specifier: '../../core/src/legacy',
      line: 2,
      reason: 'target deleted',
    });
  });

  it('writes graph.json and summary.json', async () => {
    expect(result.graphPath).toBe(join(out, 'full', 'graph.json'));
    expect(JSON.parse(await readFile(result.graphPath!, 'utf8'))).toEqual(graph);
    expect(JSON.parse(await readFile(result.summaryPath!, 'utf8'))).toEqual(
      toCommentSummary(result, 0, graph.pr.head),
    );
  });

  it('writes report.html with no external URLs', async () => {
    expect(result.reportPath).toBe(join(out, 'full', 'report.html'));
    const html = await readFile(result.reportPath!, 'utf8');
    expect(html).toContain('<script type="application/json" id="graph-data">');
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
  });
});

describe('runPipeline thresholds', () => {
  it('skips below threshold', async () => {
    const dir = join(out, 'skipped');
    const result = await runPipeline(options({ outDir: dir, minFiles: 1000 }));
    expect(result).toMatchObject({
      skipped: true,
      graph: null,
      reportPath: null,
      graphPath: null,
      summaryPath: null,
    });
    expect(result.filesChanged).toBeGreaterThan(0);
    expect(existsSync(dir) ? await readdir(dir) : []).toEqual([]);
  });
});
