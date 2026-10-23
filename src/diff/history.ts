import type { Logger } from '../log.js';
import { git } from './git.js';

const DEEPEN_STEP = 50;
const DEEPEN_ROUNDS = 5;

async function tryMergeBase(repo: string, base: string, head: string): Promise<string | null> {
  try {
    const out = (await git(repo, ['merge-base', base, head])).trim();
    return out || null;
  } catch {
    return null;
  }
}

async function isShallow(repo: string): Promise<boolean> {
  try {
    return (await git(repo, ['rev-parse', '--is-shallow-repository'])).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Returns the merge base of `base` and `head`, fetching or deepening history when the
 * checkout is too shallow to resolve it. Fails with an actionable message otherwise.
 */
export async function ensureMergeBase(
  repo: string,
  base: string,
  head: string,
  log: Logger,
): Promise<string> {
  const found = await tryMergeBase(repo, base, head);
  if (found) return found;

  log.warn(
    `Could not find the merge base of ${base} and ${head}; fetching more history. ` +
      'Use actions/checkout with `fetch-depth: 0` to avoid this.',
  );

  const attempt = async (args: string[]): Promise<string | null> => {
    try {
      await git(repo, args);
    } catch (err) {
      log.debug(`git ${args.join(' ')} failed: ${(err as Error).message}`);
    }
    return tryMergeBase(repo, base, head);
  };

  let mb = await attempt(['fetch', '--no-tags', 'origin', base, head]);
  if (mb) return mb;

  if (await isShallow(repo)) {
    for (let i = 0; i < DEEPEN_ROUNDS && !mb; i++) {
      mb = await attempt(['fetch', '--no-tags', `--deepen=${DEEPEN_STEP}`, 'origin']);
    }
    mb ??= await attempt(['fetch', '--no-tags', '--unshallow', 'origin']);
    if (mb) return mb;
  }

  throw new Error(
    `Could not find a merge base between ${base} and ${head}. ` +
      'The checkout does not contain enough history: set `fetch-depth: 0` on actions/checkout ' +
      'and make sure the base commit still exists (it may have been force-pushed away).',
  );
}
