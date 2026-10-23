import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { PipelineResult } from '../pipeline.js';

/**
 * What the sticky comment and job summary show. Written as `summary.json` into the artifact;
 * in `mode: comment` it is read back from another workflow's artifact, so it is treated as
 * hostile there (see `parseSummaryJson`).
 */
export interface CommentSummary {
  version: 1;
  skipped: boolean;
  minFiles: number;
  files: number;
  additions: number;
  deletions: number;
  edges: number;
  cycles: number;
  unresolved: number;
  parseErrors: number;
  /** The highest-ranked changed files, at most 5. */
  top: string[];
  headSha: string;
}

export const TOP_FILES = 5;
const MAX_COUNT = 10_000_000;
const MAX_PATH = 300;

const count = z.number().int().min(0).max(MAX_COUNT);

const schema = z
  .object({
    version: z.literal(1),
    skipped: z.boolean(),
    minFiles: count,
    files: count,
    additions: count,
    deletions: count,
    edges: count,
    cycles: count,
    unresolved: count,
    parseErrors: count,
    top: z.array(z.string().max(MAX_PATH)).max(TOP_FILES),
    headSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  })
  .strict();

const clamp = (n: number): number => Math.min(Math.max(Math.trunc(n) || 0, 0), MAX_COUNT);

/** Keeps the end of a path (the file name), marking the cut with an ellipsis. */
function fitPath(path: string): string {
  return path.length <= MAX_PATH ? path : '\u2026' + path.slice(path.length - (MAX_PATH - 1));
}

/** Builds a summary that always passes `parseSummaryJson`: long paths and counts are clamped. */
export function toCommentSummary(
  result: PipelineResult,
  minFiles: number,
  headSha: string,
): CommentSummary {
  const s = result.graph?.summary;
  return {
    version: 1,
    skipped: result.skipped,
    minFiles: clamp(minFiles),
    files: clamp(s?.files ?? result.filesChanged),
    additions: clamp(s?.additions ?? 0),
    deletions: clamp(s?.deletions ?? 0),
    edges: clamp(s?.edges ?? 0),
    cycles: clamp(s?.cycles ?? 0),
    unresolved: clamp(s?.unresolved ?? 0),
    parseErrors: clamp(s?.parseErrors ?? 0),
    top: (result.graph?.ranking ?? []).slice(0, TOP_FILES).map(fitPath),
    headSha,
  };
}

/** Parses and validates untrusted `summary.json` text; throws on anything off-schema. */
export function parseSummaryJson(raw: string): CommentSummary {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`summary.json is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
    throw new Error(`summary.json is invalid${where}: ${issue?.message ?? 'unknown error'}`);
  }
  return parsed.data;
}

/** Writes `summary.json` into `dir`; returns its path. */
export async function writeSummaryJson(dir: string, s: CommentSummary): Promise<string> {
  const path = join(dir, 'summary.json');
  await writeFile(path, JSON.stringify(s, null, 2) + '\n');
  return path;
}
