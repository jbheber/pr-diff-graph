import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectDiff } from './diff/collect.js';
import { filterFiles } from './diff/filter.js';
import { BlobReader } from './diff/git.js';
import { ensureMergeBase } from './diff/history.js';
import { buildGraph } from './graph/build.js';
import { collectImports } from './graph/imports.js';
import type { GraphJson } from './graph/types.js';
import type { Logger } from './log.js';
import { createRegistry } from './parsers/registry.js';
import { toCommentSummary, writeSummaryJson } from './publish/summary.js';
import { initTreeSitter } from './parsers/treesitter.js';
import { buildRepoIndex } from './repo/index.js';
import { loadReportAssets, renderReport } from './report/render.js';

export interface PipelineOptions {
  /** Path of the git repository to analyse. */
  repo: string;
  /** Base and head commit SHAs. */
  base: string;
  head: string;
  outDir: string;
  /** Skip when the filtered changed-file count is at most this. */
  minFiles: number;
  include: string[];
  exclude: string[];
  clusterDepth: number;
  collapseThreshold: number;
  scanRepo: boolean;
  maxPatchBytes: number;
  prNumber: number | null;
  repoSlug: string | null;
  log: Logger;
  /** Directory holding tree-sitter.wasm and the grammar WASMs. */
  grammarDir: string;
  /** Directory holding the report template and client bundle (see `loadReportAssets`). */
  assetsDir: string;
}

export interface PipelineResult {
  skipped: boolean;
  /** Changed files after include/exclude. */
  filesChanged: number;
  /** Changed files before filtering. */
  rawFilesChanged: number;
  graph: GraphJson | null;
  reportPath: string | null;
  graphPath: string | null;
  summaryPath: string | null;
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { repo, base, head, log } = opts;
  const mergeBase = await ensureMergeBase(repo, base, head, log);
  const raw = await collectDiff(repo, mergeBase, head, { maxPatchBytes: opts.maxPatchBytes });
  const files = filterFiles(raw, opts.include, opts.exclude);
  log.info(`${files.length} changed files (${raw.length} before include/exclude filtering)`);

  if (files.length <= opts.minFiles) {
    log.info(
      `Skipping: ${files.length} changed files is not more than min-files (${opts.minFiles})`,
    );
    return {
      skipped: true,
      filesChanged: files.length,
      rawFilesChanged: raw.length,
      graph: null,
      reportPath: null,
      graphPath: null,
      summaryPath: null,
    };
  }

  const reader = new BlobReader(repo);
  try {
    const [headIndex, baseIndex, runtime] = await Promise.all([
      buildRepoIndex(repo, head, reader, log),
      buildRepoIndex(repo, mergeBase, reader, log),
      initTreeSitter(opts.grammarDir, log),
    ]);
    const imports = await collectImports({
      files,
      reader,
      registry: createRegistry(runtime, log),
      headIndex,
      baseIndex,
      scanRepo: opts.scanRepo,
      log,
    });
    const { graph, diffs } = buildGraph({
      pr: { number: opts.prNumber, base, head, mergeBase, repo: opts.repoSlug },
      files,
      imports,
      headIndex,
      baseIndex,
      clusterDepth: opts.clusterDepth,
      rawFiles: raw.length,
    });

    const assets = await loadReportAssets(opts.assetsDir);
    const html = renderReport(graph, diffs, { collapseThreshold: opts.collapseThreshold }, assets);

    await mkdir(opts.outDir, { recursive: true });
    const reportPath = join(opts.outDir, 'report.html');
    const graphPath = join(opts.outDir, 'graph.json');
    await writeFile(reportPath, html);
    await writeFile(graphPath, JSON.stringify(graph, null, 2) + '\n');
    log.info(
      `${graph.summary.files} files, ${graph.summary.edges} edges, ${graph.summary.cycles} cycles`,
    );

    const result: PipelineResult = {
      skipped: false,
      filesChanged: files.length,
      rawFilesChanged: raw.length,
      graph,
      reportPath,
      graphPath,
      summaryPath: null,
    };
    // summary.json holds what the sticky comment shows; `mode: comment` reads it back.
    result.summaryPath = await writeSummaryJson(
      opts.outDir,
      toCommentSummary(result, opts.minFiles, head),
    );
    return result;
  } finally {
    reader.close();
  }
}
