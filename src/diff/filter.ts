import picomatch from 'picomatch';
import type { ChangedFile } from './collect.js';

export const DEFAULT_EXCLUDE: string[] = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/go.sum',
  '**/poetry.lock',
  '**/uv.lock',
  '**/Cargo.lock',
  '**/dist/**',
  '**/build/**',
  '**/*.min.js',
  '**/*.map',
  '**/__snapshots__/**',
];

/**
 * Keeps the files that match `include` (empty = all) and none of the exclude globs.
 * A renamed file matches on either its new or its old path. A non-empty user `exclude`
 * replaces the default list instead of extending it.
 */
export function filterFiles(
  files: ChangedFile[],
  include: string[],
  exclude: string[],
): ChangedFile[] {
  const excludeGlobs = exclude.length > 0 ? exclude : DEFAULT_EXCLUDE;
  const isIncluded = include.length > 0 ? picomatch(include, { dot: true }) : () => true;
  const isExcluded = picomatch(excludeGlobs, { dot: true });
  const matches = (test: (p: string) => boolean, f: ChangedFile) =>
    test(f.path) || (f.oldPath !== null && test(f.oldPath));
  return files.filter((f) => matches(isIncluded, f) && !matches(isExcluded, f));
}
