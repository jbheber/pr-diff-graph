import type { RepoIndex } from '../repo/index.js';
import { join } from '../repo/paths.js';
import type { RawImport, Resolution } from './types.js';

/**
 * Resolves a Go import path: the longest module-path prefix in the repo maps it to a package
 * directory, whose non-test `.go` files are the target; no prefix means external.
 */
export function resolveGoImport(imp: RawImport, _from: string, repo: RepoIndex): Resolution {
  const spec = imp.specifier;
  let best: { dir: string; modulePath: string } | null = null;
  for (const m of repo.goModules) {
    if (
      (spec === m.modulePath || spec.startsWith(`${m.modulePath}/`)) &&
      (!best || m.modulePath.length > best.modulePath.length)
    ) {
      best = m;
    }
  }
  if (!best) return { kind: 'external', name: spec };

  const dir = join(best.dir, spec.slice(best.modulePath.length + 1));
  const paths = repo
    .listDir(dir)
    .filter((p) => p.endsWith('.go') && !p.endsWith('_test.go'))
    .sort();
  return paths.length > 0 ? { kind: 'file', paths } : { kind: 'unresolved', reason: 'not found' };
}
