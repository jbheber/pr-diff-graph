import { afterEach, describe, expect, it } from 'vitest';
import { BlobReader, git, GitError } from '../../../src/diff/git.js';
import { makeRepo, type Fixture } from '../../helpers/gitfixture.js';

let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe('BlobReader', () => {
  it('reads blobs by sha and path, and returns null when missing', async () => {
    const bin = Buffer.from([0, 1, 2, 10, 255, 10]);
    fixture = await makeRepo([
      { 'a.ts': 'one\n', 'sub/odd name "q".ts': 'two\n', 'bin.dat': bin },
      { 'a.ts': null },
    ]);
    const [first, second] = fixture.shas as [string, string];
    const reader = new BlobReader(fixture.dir);
    try {
      expect((await reader.read(first, 'a.ts'))!.toString()).toBe('one\n');
      expect((await reader.read(second, 'a.ts')) === null).toBe(true);
      expect((await reader.read(second, 'sub/odd name "q".ts'))!.toString()).toBe('two\n');
      expect((await reader.read(first, 'bin.dat'))!.equals(bin)).toBe(true);
      expect(await reader.read(first, 'nope.ts')).toBeNull();
      const parallel = await Promise.all(
        ['a.ts', 'bin.dat', 'x'].map((p) => reader.read(first, p)),
      );
      expect(parallel.map((b) => b?.length ?? null)).toEqual([4, 6, null]);
    } finally {
      reader.close();
    }
  });
});

describe('git', () => {
  it('rejects with a GitError carrying args, stderr and code', async () => {
    fixture = await makeRepo([{ 'a.ts': '1' }]);
    const err = await git(fixture.dir, ['rev-parse', '--verify', 'nope^{commit}']).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).args).toContain('rev-parse');
    expect((err as GitError).code).toBe(128);
  });
});
