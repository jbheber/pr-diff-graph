import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../../src/diff/collect.js';
import { DEFAULT_EXCLUDE, filterFiles } from '../../../src/diff/filter.js';

function file(path: string, oldPath: string | null = null): ChangedFile {
  return {
    path,
    oldPath,
    status: oldPath ? 'renamed' : 'modified',
    rawStatus: oldPath ? 'R' : 'M',
    additions: 1,
    deletions: 0,
    binary: false,
    patch: null,
    patchTruncated: false,
  };
}

const paths = (files: ChangedFile[]) => files.map((f) => f.path);

describe('filterFiles', () => {
  it('excludes lockfiles and dist by default', () => {
    const files = [
      file('src/a.ts'),
      file('package-lock.json'),
      file('packages/x/yarn.lock'),
      file('dist/index.js'),
      file('packages/x/dist/index.js'),
      file('public/app.min.js'),
      file('src/__snapshots__/a.snap'),
      file('.github/workflows/ci.yml'),
    ];
    expect(paths(filterFiles(files, [], []))).toEqual(['src/a.ts', '.github/workflows/ci.yml']);
    expect(DEFAULT_EXCLUDE).toHaveLength(12);
  });

  it('include narrows to globs', () => {
    const files = [file('src/a.ts'), file('src/deep/b.ts'), file('docs/readme.md')];
    expect(paths(filterFiles(files, ['src/**'], []))).toEqual(['src/a.ts', 'src/deep/b.ts']);
  });

  it('renamed file matches on old path', () => {
    const files = [file('lib/a.ts', 'src/a.ts'), file('lib/b.ts')];
    expect(paths(filterFiles(files, ['src/**'], []))).toEqual(['lib/a.ts']);
  });

  it('user exclude replaces default', () => {
    const files = [file('package-lock.json'), file('src/a.ts'), file('src/gen.ts')];
    expect(paths(filterFiles(files, [], ['src/gen.ts']))).toEqual([
      'package-lock.json',
      'src/a.ts',
    ]);
  });
});
