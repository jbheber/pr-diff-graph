import type { RepoIndex, WorkspacePackage } from '../repo/index.js';
import { dirOf, join } from '../repo/paths.js';
import type { RawImport, Resolution } from './types.js';

/** Extension probing order for an extensionless specifier. */
const PROBE = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/** ESM-in-TS convention: a `.js` written in source names the `.ts` file it compiles from. */
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
};

/** Build output directories mapped back to `src/` when they are not in git. */
const BUILD_DIRS = new Set(['dist', 'build', 'lib', 'out']);

/** Condition priority for package `exports`; any other condition comes after these. */
const CONDITIONS = ['source', 'types', 'import', 'default', 'require'];

const NOT_FOUND: Resolution = { kind: 'unresolved', reason: 'not found' };

const found = (path: string): Resolution => ({ kind: 'file', paths: [path] });

function isRelative(spec: string): boolean {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** `.d.ts`-style declaration suffixes are matched before the plain extension. */
function extensionOf(path: string): string {
  const m = /(\.d)?\.[cm]?[jt]sx?$/.exec(path);
  return m ? m[0] : '';
}

/**
 * The repo file a module path names: exact file, `.js`→`.ts` substitution, extension
 * probing, `index.*`, then the directory's package.json `types`/`main`.
 */
function resolvePath(repo: RepoIndex, path: string, depth = 0): string | null {
  if (path.startsWith('../') || path === '..') return null;
  if (path && repo.has(path)) return path;

  const ext = extensionOf(path);
  for (const ts of JS_TO_TS[ext] ?? []) {
    const candidate = path.slice(0, -ext.length) + ts;
    if (repo.has(candidate)) return candidate;
  }
  if (path) {
    for (const e of PROBE) if (repo.has(path + e)) return path + e;
  }
  for (const e of PROBE) {
    const index = join(path, `index${e}`);
    if (repo.has(index)) return index;
  }
  const manifest = depth < 2 ? repo.packageManifest(path) : null;
  for (const entry of [manifest?.types, manifest?.main]) {
    if (!entry) continue;
    const hit = resolvePath(repo, join(path, entry), depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Like resolvePath, but a target under a build directory of `pkgDir` that is not in git
 * is looked for under `src/` instead (`dist/a.js` → `src/a.ts`, `dist/a.d.ts` → `src/a.ts`).
 */
function resolveBuilt(repo: RepoIndex, pkgDir: string, target: string): string | null {
  const direct = resolvePath(repo, target);
  if (direct) return direct;
  if (pkgDir !== '' && !target.startsWith(`${pkgDir}/`)) return null;
  const rel = pkgDir === '' ? target : target.slice(pkgDir.length + 1);
  const slash = rel.indexOf('/');
  if (slash < 0 || !BUILD_DIRS.has(rel.slice(0, slash))) return null;
  const inSrc = join(pkgDir, `src/${rel.slice(slash + 1)}`);
  const decl = /\.d\.[cm]?ts$/.exec(inSrc);
  return (
    resolvePath(repo, decl ? inSrc.slice(0, -decl[0].length) : inSrc) ?? srcIndex(repo, pkgDir)
  );
}

function srcIndex(repo: RepoIndex, pkgDir: string): string | null {
  for (const e of PROBE) {
    const index = join(pkgDir, `src/index${e}`);
    if (repo.has(index)) return index;
  }
  return null;
}

/** Targets of one `exports` value, best condition first; `*` replaced by `star`. */
function conditionTargets(value: unknown, star: string | null): string[] {
  if (typeof value === 'string') return [star === null ? value : value.split('*').join(star)];
  if (Array.isArray(value)) return value.flatMap((v) => conditionTargets(v, star));
  if (!isRecord(value)) return []; // null: explicitly blocked
  const keys = [
    ...CONDITIONS.filter((c) => c in value),
    ...Object.keys(value).filter((k) => !CONDITIONS.includes(k)),
  ];
  return keys.flatMap((k) => conditionTargets(value[k], star));
}

/**
 * Candidate targets (relative to the package dir) that `exports` gives `subpath`
 * (`.` or `./x`), or null when `exports` has no entry for it.
 */
function exportTargets(exports: unknown, subpath: string): string[] | null {
  const isSubpathMap =
    isRecord(exports) && Object.keys(exports).some((k) => k === '.' || k.startsWith('./'));
  if (!isSubpathMap) return subpath === '.' ? conditionTargets(exports, null) : null;

  if (subpath in exports) return conditionTargets(exports[subpath], null);
  let best: { key: string; star: string } | null = null;
  for (const key of Object.keys(exports)) {
    const at = key.indexOf('*');
    if (at < 0) continue;
    const prefix = key.slice(0, at);
    const suffix = key.slice(at + 1);
    if (
      subpath.length >= key.length - 1 &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      (!best || prefix.length > best.key.indexOf('*'))
    ) {
      best = { key, star: subpath.slice(prefix.length, subpath.length - suffix.length) };
    }
  }
  return best ? conditionTargets(exports[best.key], best.star) : null;
}

function resolveWorkspace(repo: RepoIndex, pkg: WorkspacePackage, spec: string): string | null {
  const rest = spec.slice(pkg.name.length + 1);
  const subpath = rest ? `./${rest}` : '.';
  const { exports, types, main } = pkg.manifest;

  if (exports !== undefined) {
    const targets = exportTargets(exports, subpath);
    if (targets) {
      for (const t of targets) {
        const hit = resolveBuilt(repo, pkg.dir, join(pkg.dir, t));
        if (hit) return hit;
      }
      return null;
    }
  }
  if (rest) return resolveBuilt(repo, pkg.dir, join(pkg.dir, rest));
  for (const entry of [types, main]) {
    if (!entry) continue;
    const hit = resolveBuilt(repo, pkg.dir, join(pkg.dir, entry));
    if (hit) return hit;
  }
  return srcIndex(repo, pkg.dir) ?? resolvePath(repo, pkg.dir);
}

/** The tsconfig `paths` pattern `spec` matches (exact first, then longest prefix), with its `*`. */
function matchPaths(
  paths: Record<string, string[]>,
  spec: string,
): { targets: string[]; star: string; pattern: string } | null {
  if (paths[spec]) return { targets: paths[spec], star: '', pattern: spec };
  let best: { targets: string[]; star: string; pattern: string } | null = null;
  for (const [pattern, targets] of Object.entries(paths)) {
    const at = pattern.indexOf('*');
    if (at < 0) continue;
    const prefix = pattern.slice(0, at);
    const suffix = pattern.slice(at + 1);
    if (
      spec.length >= pattern.length - 1 &&
      spec.startsWith(prefix) &&
      spec.endsWith(suffix) &&
      (!best || prefix.length > best.pattern.indexOf('*'))
    ) {
      best = { targets, star: spec.slice(prefix.length, spec.length - suffix.length), pattern };
    }
  }
  return best;
}

function externalName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

/**
 * Resolves a TS/JS import in the spec's order: relative, tsconfig `paths`/`baseUrl`
 * (nearest config), workspace packages, then external. Synchronous; reads only `repo`.
 */
export function resolveTsImport(imp: RawImport, from: string, repo: RepoIndex): Resolution {
  // Bundler suffixes (`?react`, `?raw`, `#hash`) are not part of the path.
  const spec = imp.specifier.replace(/(?<=.)[?#].*$/s, '');
  if (!spec) return NOT_FOUND;

  if (imp.kind === 'reference' || isRelative(spec)) {
    const hit = resolvePath(repo, join(dirOf(from), spec));
    return hit ? found(hit) : NOT_FOUND;
  }
  if (spec.startsWith('/') || spec.startsWith('#')) return NOT_FOUND;

  const config = repo.nearestTsConfig(from);
  let aliased = false;
  if (config) {
    const match = matchPaths(config.paths, spec);
    if (match) {
      for (const t of match.targets) {
        const hit = resolvePath(repo, t.split('*').join(match.star));
        if (hit) return found(hit);
      }
      // A catch-all `*` pattern is a fallback lookup, not an alias.
      aliased = match.pattern !== '*';
    }
    if (config.baseUrl !== null) {
      const hit = resolvePath(repo, join(config.baseUrl, spec));
      if (hit) return found(hit);
    }
  }

  let pkg: WorkspacePackage | null = null;
  for (const w of repo.workspaces) {
    if (
      (spec === w.name || spec.startsWith(`${w.name}/`)) &&
      (!pkg || w.name.length > pkg.name.length)
    )
      pkg = w;
  }
  if (pkg) {
    const hit = resolveWorkspace(repo, pkg, spec);
    return hit ? found(hit) : NOT_FOUND;
  }
  if (aliased) return NOT_FOUND;

  if (spec.startsWith('node:')) return { kind: 'external', name: spec.split('/')[0]! };
  return { kind: 'external', name: externalName(spec) };
}
