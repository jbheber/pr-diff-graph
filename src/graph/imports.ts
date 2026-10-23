import type { ChangedFile } from '../diff/collect.js';
import type { BlobReader } from '../diff/git.js';
import type { Logger } from '../log.js';
import type { ParserRegistry } from '../parsers/registry.js';
import {
  MAX_PARSE_BYTES,
  type LanguageParser,
  type RawImport,
  type Resolution,
} from '../parsers/types.js';
import type { RepoIndex } from '../repo/index.js';
import type { FileImports, ImportEntry } from './types.js';

/** Most files parsed when scan-repo is on. */
export const SCAN_CAP = 20_000;
/** Blobs requested ahead of the (single-threaded) parser. */
const READ_AHEAD = 64;

export interface CollectImportsArgs {
  files: ChangedFile[];
  reader: BlobReader;
  registry: ParserRegistry;
  headIndex: RepoIndex;
  baseIndex: RepoIndex;
  scanRepo: boolean;
  log: Logger;
}

interface Job {
  path: string;
  parser: LanguageParser;
  index: RepoIndex;
}

/**
 * Parses and resolves every changed file (at head; deleted files at the merge base), adds a
 * language-only entry for each unchanged file they import, and with `scanRepo` parses every
 * other head file to find unchanged importers of changed files. Never throws for one file.
 */
export async function collectImports(args: CollectImportsArgs): Promise<Map<string, FileImports>> {
  const { registry, headIndex, baseIndex, log } = args;
  const result = new Map<string, FileImports>();
  const languageOf = (path: string) => registry.forPath(path)?.id ?? null;

  const jobs: Job[] = [];
  for (const f of args.files) {
    const parser = registry.forPath(f.path);
    if (!parser || f.binary) {
      result.set(f.path, { language: parser?.id ?? null, parseError: null, imports: [] });
      continue;
    }
    jobs.push({ path: f.path, parser, index: f.status === 'deleted' ? baseIndex : headIndex });
  }

  await forEachBlob(args.reader, jobs, (job, blob) => {
    const entry = parseFile(job, blob);
    if (entry.parseError) {
      log.warn(`${job.path}: ${entry.parseError}; shown without import edges`);
    } else if (job.index === headIndex) {
      // An import that is missing at head may name a file this PR deleted: keep how it
      // resolved at the merge base so the graph can tell the two apart.
      for (const e of entry.imports) {
        if (e.res.kind === 'unresolved')
          e.baseRes = safeResolve(job.parser, e.imp, job.path, baseIndex);
      }
    }
    result.set(job.path, entry);
  });

  if (args.scanRepo) {
    const changed = new Set(args.files.map((f) => f.path));
    const candidates: Job[] = [];
    for (const path of [...headIndex.files].sort()) {
      const parser = changed.has(path) ? null : registry.forPath(path);
      if (parser) candidates.push({ path, parser, index: headIndex });
    }
    if (candidates.length > SCAN_CAP) {
      log.warn(
        `scan-repo: ${candidates.length} parseable files, only the first ${SCAN_CAP} are scanned`,
      );
    }
    await forEachBlob(args.reader, candidates.slice(0, SCAN_CAP), (job, blob) => {
      const entry = parseFile(job, blob);
      if (entry.parseError) log.debug(`scan-repo: ${job.path}: ${entry.parseError}`);
      // Only imports that reach a changed file can become edges.
      entry.imports = entry.imports.filter(
        (e) => e.res.kind === 'file' && e.res.paths.some((p) => changed.has(p)),
      );
      if (entry.imports.length > 0) result.set(job.path, entry);
    });
  }

  for (const f of args.files) {
    for (const { res } of result.get(f.path)?.imports ?? []) {
      if (res.kind !== 'file') continue;
      for (const p of res.paths) {
        if (!result.has(p))
          result.set(p, { language: languageOf(p), parseError: null, imports: [] });
      }
    }
  }
  return result;
}

function parseFile(job: Job, blob: Buffer | null): FileImports {
  const language = job.parser.id;
  if (blob === null) return { language, parseError: 'file not found in git', imports: [] };
  if (blob.length > MAX_PARSE_BYTES) {
    return { language, parseError: 'file too large to parse', imports: [] };
  }
  let raw;
  try {
    raw = job.parser.parse(blob.toString('utf8'), job.path);
  } catch (e) {
    return { language, parseError: (e as Error).message || 'parse failed', imports: [] };
  }
  const imports: ImportEntry[] = raw.map((imp) => ({
    imp,
    res: safeResolve(job.parser, imp, job.path, job.index),
  }));
  return { language, parseError: null, imports };
}

/** Resolves one import; a resolver that throws costs that import only, not the file. */
function safeResolve(
  parser: LanguageParser,
  imp: RawImport,
  from: string,
  index: RepoIndex,
): Resolution {
  try {
    return parser.resolve(imp, from, index);
  } catch (e) {
    return { kind: 'unresolved', reason: `resolver error: ${(e as Error).message}` };
  }
}

/** Calls `fn` for each job in order with its blob, reading the next batch while parsing. */
async function forEachBlob(
  reader: BlobReader,
  jobs: Job[],
  fn: (job: Job, blob: Buffer | null) => void,
): Promise<void> {
  const read = (start: number) =>
    Promise.all(jobs.slice(start, start + READ_AHEAD).map((j) => reader.read(j.index.sha, j.path)));
  let pending = read(0);
  for (let start = 0; start < jobs.length; start += READ_AHEAD) {
    const blobs = await pending;
    if (start + READ_AHEAD < jobs.length) pending = read(start + READ_AHEAD);
    blobs.forEach((blob, i) => fn(jobs[start + i]!, blob));
  }
}
