import { afterEach } from 'vitest';
import { BlobReader } from '../../../src/diff/git.js';
import type { Logger } from '../../../src/log.js';
import { buildRepoIndex, type RepoIndex } from '../../../src/repo/index.js';
import { makeRepo, type FileMap, type Fixture } from '../../helpers/gitfixture.js';

const fixtures: Fixture[] = [];
const readers: BlobReader[] = [];

afterEach(async () => {
  for (const r of readers.splice(0)) r.close();
  for (const f of fixtures.splice(0)) await f.cleanup();
});

export function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, info() {}, warn: (m) => warnings.push(m), debug() {} };
}

/** Builds a one-commit repo from `files` and indexes it. */
export async function indexOf(files: FileMap, log: Logger = recordingLogger()): Promise<RepoIndex> {
  const fx = await makeRepo([files]);
  fixtures.push(fx);
  const reader = new BlobReader(fx.dir);
  readers.push(reader);
  return buildRepoIndex(fx.dir, fx.shas[0]!, reader, log);
}
