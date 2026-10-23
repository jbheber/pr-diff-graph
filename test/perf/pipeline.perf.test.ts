import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { silentLogger } from '../../src/log.js';
import { grammarDir } from '../../src/parsers/treesitter.js';
import { runPipeline } from '../../src/pipeline.js';
import { makeRepo, type FileMap, type Fixture } from '../helpers/gitfixture.js';

const FILES = 300;
const BUDGET_MS = 30_000;

/** Deterministic PRNG (mulberry32) so the generated repo is the same on every run. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pathOf = (i: number) => `src/mod${i % 10}/file${i}.ts`;

function source(i: number, rand: () => number, version: number): string {
  const lines: string[] = [];
  const count = 1 + Math.floor(rand() * 6);
  for (let k = 0; k < count; k++) {
    const j = Math.floor(rand() * FILES);
    if (j !== i) lines.push(`import { v${j} } from '../mod${j % 10}/file${j}';`);
  }
  lines.push(`import { readFile } from 'node:fs';`);
  for (let k = 0; k < 40; k++) lines.push(`export const x${k}_${version} = ${k} * ${i};`);
  lines.push(`export const v${i} = ${version};`);
  return lines.join('\n') + '\n';
}

let fixture: Fixture;
let out: string;

beforeAll(async () => {
  const rand = random(1234);
  const base: FileMap = {};
  const head: FileMap = {};
  for (let i = 0; i < FILES; i++) {
    base[pathOf(i)] = source(i, rand, 1);
    head[pathOf(i)] = source(i, rand, 2);
  }
  fixture = await makeRepo([base, head]);
  out = await mkdtemp(join(tmpdir(), 'pdg-perf-'));
}, 120_000);

afterAll(async () => {
  await fixture?.cleanup();
  if (out) await rm(out, { recursive: true, force: true });
});

it(`runs the pipeline on a ${FILES}-file TS repo in under ${BUDGET_MS} ms`, async () => {
  const started = performance.now();
  const result = await runPipeline({
    repo: fixture.dir,
    base: fixture.shas[0]!,
    head: fixture.shas[1]!,
    outDir: out,
    minFiles: 0,
    include: [],
    exclude: [],
    clusterDepth: 2,
    collapseThreshold: 150,
    scanRepo: false,
    maxPatchBytes: 200_000,
    prNumber: null,
    repoSlug: null,
    log: silentLogger,
    grammarDir: grammarDir(),
    assetsDir: '',
  });
  const elapsed = performance.now() - started;
  expect(result.graph?.summary.files).toBe(FILES);
  expect(result.graph?.summary.edges).toBeGreaterThan(FILES);
  expect(elapsed).toBeLessThan(BUDGET_MS);
});
