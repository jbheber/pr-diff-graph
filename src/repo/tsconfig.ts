import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import type { Logger } from '../log.js';
import { baseOf, dirOf, join, norm } from './paths.js';
import type { WorkspacePackage } from './workspaces.js';

export interface TsConfigInfo {
  /** Directory of the tsconfig.json / jsconfig.json, repo-relative ('' for the root). */
  dir: string;
  /** Effective `baseUrl`, repo-relative; null when none is set anywhere in the chain. */
  baseUrl: string | null;
  /** Pattern to targets, targets repo-relative (after `baseUrl`, or the config's dir). */
  paths: Record<string, string[]>;
}

export interface TsConfigContext {
  files: ReadonlySet<string>;
  readText(path: string): Promise<string | null>;
  workspaces: readonly WorkspacePackage[];
  log: Logger;
}

interface Resolved {
  /** Repo-relative, already joined to the directory of the config that set it. */
  baseUrl: string | null;
  paths: Record<string, string[]> | null;
  /** Directory of the config that defined `paths`. */
  pathsDir: string;
}

const EMPTY: Resolved = { baseUrl: null, paths: null, pathsDir: '' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function pathsOf(v: unknown): Record<string, string[]> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, string[]> = {};
  for (const [k, t] of Object.entries(v)) {
    if (Array.isArray(t)) out[k] = t.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

class Loader {
  private readonly cache = new Map<string, Record<string, unknown> | null>();

  constructor(private readonly ctx: TsConfigContext) {}

  private async raw(path: string): Promise<Record<string, unknown> | null> {
    if (this.cache.has(path)) return this.cache.get(path)!;
    let result: Record<string, unknown> | null = null;
    const text = await this.ctx.readText(path);
    if (text !== null) {
      const errors: ParseError[] = [];
      const parsed: unknown = parseJsonc(text, errors, {
        allowTrailingComma: true,
        disallowComments: false,
      });
      if (isRecord(parsed)) result = parsed;
      else this.ctx.log.warn(`could not parse ${path}; ignoring it`);
    }
    this.cache.set(path, result);
    return result;
  }

  /** The first existing file among `base`, `base.json` and `base/tsconfig.json`. */
  private firstFile(base: string): string | null {
    for (const c of [base, `${base}.json`, join(base, 'tsconfig.json')]) {
      if (this.ctx.files.has(c)) return c;
    }
    return null;
  }

  /** Repo path of the config an `extends` entry points to, or null (with a warning). */
  private resolveExtends(fromPath: string, spec: string): string | null {
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      const found = this.firstFile(join(dirOf(fromPath), spec));
      if (!found) this.ctx.log.warn(`${fromPath}: extends "${spec}" was not found in the repo`);
      return found;
    }
    // A package name: only resolvable when it is a workspace package of this repo.
    for (const w of this.ctx.workspaces) {
      if (spec !== w.name && !spec.startsWith(w.name + '/')) continue;
      const sub = spec.slice(w.name.length + 1);
      const found = this.firstFile(sub ? join(w.dir, sub) : join(w.dir, 'tsconfig.json'));
      if (found) return found;
    }
    this.ctx.log.warn(
      `${fromPath}: extends "${spec}" needs an installed package (node_modules is not in git); ignoring it`,
    );
    return null;
  }

  async resolve(path: string, seen: readonly string[] = []): Promise<Resolved> {
    if (seen.includes(path)) {
      this.ctx.log.warn(`${path}: circular extends; ignoring it`);
      return EMPTY;
    }
    const raw = await this.raw(path);
    if (!raw) return EMPTY;
    const dir = dirOf(path);
    const merged: Resolved = { ...EMPTY };

    const ext = raw['extends'];
    const specs = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : [];
    for (const spec of specs) {
      if (typeof spec !== 'string') continue;
      const target = this.resolveExtends(path, spec);
      if (!target) continue;
      const parent = await this.resolve(target, [...seen, path]);
      if (parent.baseUrl !== null) merged.baseUrl = parent.baseUrl;
      if (parent.paths) {
        merged.paths = parent.paths;
        merged.pathsDir = parent.pathsDir;
      }
    }

    const options = raw['compilerOptions'];
    if (isRecord(options)) {
      if (typeof options['baseUrl'] === 'string') merged.baseUrl = join(dir, options['baseUrl']);
      const own = pathsOf(options['paths']);
      if (own) {
        merged.paths = own;
        merged.pathsDir = dir;
      }
    }
    return merged;
  }

  /** Configs a tsconfig.json points to with `references`, as repo paths. */
  async references(path: string): Promise<string[]> {
    const refs = (await this.raw(path))?.['references'];
    if (!Array.isArray(refs)) return [];
    const out: string[] = [];
    for (const r of refs) {
      const p = isRecord(r) ? r['path'] : null;
      if (typeof p !== 'string') continue;
      const found = this.firstFile(join(dirOf(path), p));
      if (found) out.push(found);
    }
    return out;
  }
}

function toInfo(dir: string, r: Resolved): TsConfigInfo {
  const base = r.baseUrl ?? r.pathsDir;
  const paths: Record<string, string[]> = {};
  for (const [pattern, targets] of Object.entries(r.paths ?? {})) {
    paths[pattern] = targets.map((t) => norm(join(base, t)));
  }
  return { dir, baseUrl: r.baseUrl, paths };
}

/**
 * One entry per directory holding a tsconfig.json (or, failing that, a jsconfig.json),
 * with its `extends` chain merged. A solution-style config with no `paths` of its own
 * adopts those of the configs it `references` that are not primary configs themselves
 * (the Vite `tsconfig.app.json` layout).
 */
export async function loadTsConfigs(ctx: TsConfigContext): Promise<TsConfigInfo[]> {
  const loader = new Loader(ctx);
  const byDir = new Map<string, string>();
  for (const f of ctx.files) if (baseOf(f) === 'jsconfig.json') byDir.set(dirOf(f), f);
  // A tsconfig.json beats a jsconfig.json in the same directory.
  for (const f of ctx.files) if (baseOf(f) === 'tsconfig.json') byDir.set(dirOf(f), f);
  const primary = new Set(byDir.values());

  const result: TsConfigInfo[] = [];
  for (const [dir, path] of byDir) {
    let resolved = await loader.resolve(path);
    if (resolved.paths === null && resolved.baseUrl === null) {
      for (const ref of await loader.references(path)) {
        if (primary.has(ref)) continue;
        const r = await loader.resolve(ref);
        if (r.paths !== null || r.baseUrl !== null) {
          resolved = r;
          break;
        }
      }
    }
    result.push(toInfo(dir, resolved));
  }
  return result.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}
