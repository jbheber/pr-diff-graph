import { git } from './git.js';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  /** For deleted files this is the old path. */
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  /** The git status letter (A, M, D, R, C, T). */
  rawStatus: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string | null;
  patchTruncated: boolean;
}

const PATCH_BATCH = 200;
const TRUNCATION_MARKER = '\n... patch truncated ...\n';

interface StatusEntry {
  path: string;
  oldPath: string | null;
  letter: string;
}

interface NumstatEntry {
  additions: number;
  deletions: number;
  binary: boolean;
}

function mapStatus(letter: string): ChangeStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'modified'; // M, C, T
  }
}

/** Parses `--name-status -z`: `M\0path\0` or `R100\0old\0new\0`. Order is git's. */
function parseNameStatus(out: string): StatusEntry[] {
  const tokens = out.split('\0');
  const entries: StatusEntry[] = [];
  let i = 0;
  while (i < tokens.length && tokens[i]) {
    const letter = tokens[i]!.charAt(0);
    if (letter === 'R' || letter === 'C') {
      entries.push({ letter, oldPath: tokens[i + 1]!, path: tokens[i + 2]! });
      i += 3;
    } else {
      entries.push({ letter, oldPath: null, path: tokens[i + 1]! });
      i += 2;
    }
  }
  return entries;
}

/** Parses `--numstat -z`: `1\t2\tpath\0` or `1\t2\t\0old\0new\0`, keyed by the new path. */
function parseNumstat(out: string): Map<string, NumstatEntry> {
  const tokens = out.split('\0');
  const result = new Map<string, NumstatEntry>();
  let i = 0;
  while (i < tokens.length && tokens[i]) {
    const first = tokens[i]!;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(first);
    if (!m) throw new Error(`unexpected numstat record: ${JSON.stringify(first)}`);
    const binary = m[1] === '-';
    const entry = {
      additions: binary ? 0 : Number(m[1]),
      deletions: binary ? 0 : Number(m[2]),
      binary,
    };
    if (m[3] === '') {
      result.set(tokens[i + 2]!, entry);
      i += 3;
    } else {
      result.set(m[3]!, entry);
      i += 1;
    }
  }
  return result;
}

/** Splits `git diff --patch` output into one chunk per `diff --git` header, in order. */
function splitPatch(out: string): string[] {
  if (!out) return [];
  // Content lines of a patch always start with ' ', '+', '-', '@' or '\', never "diff".
  return out.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
}

function truncate(patch: string, maxBytes: number): { patch: string; truncated: boolean } {
  const bytes = Buffer.from(patch, 'utf8');
  if (bytes.length <= maxBytes) return { patch, truncated: false };
  const cut = bytes.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
  return { patch: cut + TRUNCATION_MARKER, truncated: true };
}

async function patchesFor(
  repo: string,
  mergeBase: string,
  head: string,
  batch: StatusEntry[],
): Promise<string[]> {
  const paths = batch.flatMap((e) => (e.oldPath ? [e.oldPath, e.path] : [e.path]));
  const run = async (specs: string[]) =>
    splitPatch(
      await git(repo, [
        '--literal-pathspecs',
        'diff',
        '-M',
        '--patch',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        mergeBase,
        head,
        '--',
        ...specs,
      ]),
    );
  const chunks = await run(paths);
  if (chunks.length === batch.length) return chunks;
  // Misaligned (should not happen): fall back to one diff per file so nothing is mislabelled.
  const result: string[] = [];
  for (const e of batch) {
    const one = await run(e.oldPath ? [e.oldPath, e.path] : [e.path]);
    result.push(one[0] ?? '');
  }
  return result;
}

export async function collectDiff(
  repo: string,
  mergeBase: string,
  head: string,
  opts: { maxPatchBytes: number },
): Promise<ChangedFile[]> {
  const diffArgs = ['--literal-pathspecs', 'diff', '-z', '-M', '--no-ext-diff'];
  const [numstatOut, statusOut] = await Promise.all([
    git(repo, [...diffArgs, '--numstat', mergeBase, head]),
    git(repo, [...diffArgs, '--name-status', mergeBase, head]),
  ]);
  const numstat = parseNumstat(numstatOut);
  const statuses = parseNameStatus(statusOut);

  const files: ChangedFile[] = [];
  for (let i = 0; i < statuses.length; i += PATCH_BATCH) {
    const batch = statuses.slice(i, i + PATCH_BATCH);
    const patches = await patchesFor(repo, mergeBase, head, batch);
    batch.forEach((e, idx) => {
      const stat = numstat.get(e.path) ?? { additions: 0, deletions: 0, binary: false };
      let patch: string | null = null;
      let patchTruncated = false;
      if (!stat.binary) {
        const t = truncate(patches[idx] ?? '', opts.maxPatchBytes);
        patch = t.patch;
        patchTruncated = t.truncated;
      }
      files.push({
        path: e.path,
        oldPath: e.oldPath,
        status: mapStatus(e.letter),
        rawStatus: e.letter,
        additions: stat.additions,
        deletions: stat.deletions,
        binary: stat.binary,
        patch,
        patchTruncated,
      });
    });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
