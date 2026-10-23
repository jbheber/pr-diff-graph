import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureMergeBase } from '../../../src/diff/history.js';
import type { Logger } from '../../../src/log.js';
import { makeRepo, type Fixture } from '../../helpers/gitfixture.js';

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function recorder() {
  const warnings: string[] = [];
  const log: Logger = { info: () => {}, warn: (m) => warnings.push(m), debug: () => {} };
  return { log, warnings };
}

async function fixtureOf(commits: Parameters<typeof makeRepo>[0]): Promise<Fixture> {
  const f = await makeRepo(commits);
  cleanups.push(f.cleanup);
  return f;
}

describe('ensureMergeBase', () => {
  it('returns the merge base when history is present', async () => {
    const f = await fixtureOf([{ 'a.ts': '1' }, { 'a.ts': '2' }, { 'a.ts': '3' }]);
    const { log, warnings } = recorder();
    const mb = await ensureMergeBase(f.dir, f.shas[0]!, f.shas[2]!, log);
    expect(mb).toBe(f.shas[0]);
    expect(warnings).toEqual([]);
  });

  it('deepens a shallow clone until the merge base resolves', async () => {
    const commits = Array.from({ length: 30 }, (_, i) => ({ 'a.ts': String(i) }));
    const origin = await fixtureOf(commits);
    const parent = await mkdtemp(join(tmpdir(), 'pdg-clone-'));
    cleanups.push(() => rm(parent, { recursive: true, force: true, maxRetries: 3 }));
    const dir = join(parent, 'shallow');
    const url = `file:///${origin.dir.replace(/\\/g, '/').replace(/^\/+/, '')}`;
    await exec('git', ['clone', '--depth', '1', '--no-checkout', '-q', url, dir]);

    const { log, warnings } = recorder();
    const base = origin.shas[5]!;
    const head = origin.shas[29]!;
    const mb = await ensureMergeBase(dir, base, head, log);
    expect(mb).toBe(base);
    expect(warnings.some((w) => w.includes('fetch-depth: 0'))).toBe(true);
  });

  it('fails with an actionable message when the base cannot be fetched', async () => {
    const f = await fixtureOf([{ 'a.ts': '1' }, { 'a.ts': '2' }]);
    const missing = 'deadbeef'.repeat(5);
    const { log } = recorder();
    const err = await ensureMergeBase(f.dir, missing, f.shas[1]!, log).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('fetch-depth: 0');
    expect((err as Error).message).toContain(missing);
  });
});
