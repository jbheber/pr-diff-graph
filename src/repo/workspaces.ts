import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import type { Logger } from '../log.js';
import { baseOf, dirOf } from './paths.js';

export interface WorkspacePackage {
  name: string;
  dir: string;
  manifest: { main?: string; types?: string; exports?: unknown };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Workspace globs declared by a package.json (`workspaces: [...]` or `{ packages: [...] }`). */
function packageJsonPatterns(pkg: Record<string, unknown>): string[] {
  const ws = pkg['workspaces'];
  if (Array.isArray(ws)) return stringList(ws);
  return stringList(asRecord(ws)?.['packages']);
}

function cleanPattern(p: string): string {
  return p.replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Finds workspace packages. `manifests` holds the text of every package.json and
 * pnpm-workspace.yaml in the repo, keyed by path.
 */
export function findWorkspaces(
  manifests: ReadonlyMap<string, string>,
  log: Logger,
): WorkspacePackage[] {
  const packages = new Map<string, Record<string, unknown>>();
  for (const [path, text] of manifests) {
    if (baseOf(path) !== 'package.json') continue;
    try {
      const parsed = asRecord(JSON.parse(text));
      if (parsed) packages.set(dirOf(path), parsed);
    } catch {
      log.warn(`could not parse ${path}; ignoring it`);
    }
  }

  const found = new Map<string, WorkspacePackage>();
  const addFrom = (rootDir: string, patterns: string[]) => {
    const positive = patterns.filter((p) => !p.startsWith('!')).map(cleanPattern);
    const negative = patterns.filter((p) => p.startsWith('!')).map((p) => cleanPattern(p.slice(1)));
    if (positive.length === 0) return;
    const isMember = picomatch(positive, { dot: true, ignore: negative });
    for (const [dir, pkg] of packages) {
      if (dir === rootDir) continue;
      const rel =
        rootDir === '' ? dir : dir.startsWith(rootDir + '/') ? dir.slice(rootDir.length + 1) : null;
      if (rel === null || !isMember(rel)) continue;
      const name = pkg['name'];
      if (typeof name !== 'string' || !name) continue;
      const manifest: WorkspacePackage['manifest'] = {};
      if (typeof pkg['main'] === 'string') manifest.main = pkg['main'];
      if (typeof pkg['types'] === 'string') manifest.types = pkg['types'];
      else if (typeof pkg['typings'] === 'string') manifest.types = pkg['typings'];
      if (pkg['exports'] !== undefined) manifest.exports = pkg['exports'];
      found.set(dir, { name, dir, manifest });
    }
  };

  for (const [dir, pkg] of packages) addFrom(dir, packageJsonPatterns(pkg));

  for (const [path, text] of manifests) {
    if (baseOf(path) !== 'pnpm-workspace.yaml') continue;
    try {
      addFrom(dirOf(path), stringList(asRecord(parseYaml(text))?.['packages']));
    } catch {
      log.warn(`could not parse ${path}; ignoring it`);
    }
  }
  return [...found.values()].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/** The workspace package that contains `path` (the deepest one), or null. */
export function owningPackage(
  workspaces: readonly WorkspacePackage[],
  path: string,
): WorkspacePackage | null {
  let best: WorkspacePackage | null = null;
  for (const w of workspaces) {
    const inside = w.dir === '' || path === w.dir || path.startsWith(w.dir + '/');
    if (inside && (!best || w.dir.length > best.dir.length)) best = w;
  }
  return best;
}
