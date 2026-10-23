import { baseOf, dirOf } from './paths.js';

/**
 * Directories imports may be rooted at: the repo root, `src/` when present, and every
 * directory holding a `pyproject.toml` or `setup.cfg`. Sorted; `''` is the root.
 */
export function findPythonRoots(files: Iterable<string>): string[] {
  const roots = new Set<string>(['']);
  for (const f of files) {
    if (f.startsWith('src/')) roots.add('src');
    const b = baseOf(f);
    if (b === 'pyproject.toml' || b === 'setup.cfg') roots.add(dirOf(f));
  }
  return [...roots].sort();
}
