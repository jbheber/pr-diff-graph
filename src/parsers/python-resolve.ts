import type { RepoIndex } from '../repo/index.js';
import { dirOf, join } from '../repo/paths.js';
import type { RawImport, Resolution } from './types.js';

const NOT_FOUND: Resolution = { kind: 'unresolved', reason: 'not found' };

/** Module file, then package `__init__`, each `.py` before `.pyi`. `path` is root-relative. */
function moduleFile(repo: RepoIndex, path: string): string | null {
  const candidates = path
    ? [`${path}.py`, `${path}.pyi`, `${path}/__init__.py`, `${path}/__init__.pyi`]
    : ['__init__.py', '__init__.pyi'];
  return candidates.find((c) => repo.has(c)) ?? null;
}

/**
 * Files an import names under `base` (a directory path, '' = repo root): each `module.name`
 * that is a module, plus the module itself when there are no names or one is not a module.
 */
function resolveUnder(repo: RepoIndex, base: string, module: string, names: string[]): string[] {
  const dir = join(base, module.split('.').filter(Boolean).join('/'));
  const found = new Set<string>();
  let needsModule = names.length === 0;
  for (const name of names) {
    const hit = moduleFile(repo, join(dir, name));
    if (hit) found.add(hit);
    else needsModule = true;
  }
  if (needsModule) {
    const hit = moduleFile(repo, dir);
    if (hit) found.add(hit);
  }
  return [...found].sort();
}

/**
 * Resolves a Python import: relative (`.`/`..`) against the importing file's package,
 * absolute against each Python root in order (first hit wins), otherwise external.
 */
export function resolvePythonImport(imp: RawImport, from: string, repo: RepoIndex): Resolution {
  const spec = imp.specifier;
  const names = imp.names ?? [];
  const dots = /^\.*/.exec(spec)![0].length;
  const module = spec.slice(dots);

  if (dots > 0) {
    let base = dirOf(from);
    for (let i = 1; i < dots; i++) {
      if (base === '') return NOT_FOUND;
      base = dirOf(base);
    }
    const paths = resolveUnder(repo, base, module, names);
    return paths.length > 0 ? { kind: 'file', paths } : NOT_FOUND;
  }

  if (!module) return NOT_FOUND;
  for (const root of repo.pythonRoots) {
    const paths = resolveUnder(repo, root, module, names);
    if (paths.length > 0) return { kind: 'file', paths };
  }
  return { kind: 'external', name: module.split('.')[0]! };
}
