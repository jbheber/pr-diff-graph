import type { Logger } from '../log.js';
import { baseOf, dirOf, join } from './paths.js';

export interface GoModule {
  dir: string;
  modulePath: string;
}

function stripComment(line: string): string {
  return line.replace(/\/\/.*$/, '').trim();
}

function unquote(s: string): string {
  return s.replace(/^["`](.*)["`]$/, '$1');
}

function parseModulePath(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const m = /^module\s+(\S+)/.exec(stripComment(raw));
    if (m) return unquote(m[1]!);
  }
  return null;
}

/** Directories named by `use` directives (single-line and block form) of a go.work file. */
function parseUseDirs(text: string): string[] {
  const dirs: string[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (inBlock) {
      if (line === ')') inBlock = false;
      else if (line) dirs.push(unquote(line));
    } else if (/^use\s*\($/.test(line)) {
      inBlock = true;
    } else {
      const m = /^use\s+(\S+)/.exec(line);
      if (m) dirs.push(unquote(m[1]!));
    }
  }
  return dirs;
}

/** Go modules from `go.mod` files; `go.work` `use` entries are checked against them. */
export function findGoModules(manifests: ReadonlyMap<string, string>, log: Logger): GoModule[] {
  const modules: GoModule[] = [];
  const dirs = new Set<string>();
  for (const [path, text] of manifests) {
    if (baseOf(path) !== 'go.mod') continue;
    const modulePath = parseModulePath(text);
    if (!modulePath) {
      log.warn(`no module directive in ${path}; ignoring it`);
      continue;
    }
    const dir = dirOf(path);
    dirs.add(dir);
    modules.push({ dir, modulePath });
  }
  for (const [path, text] of manifests) {
    if (baseOf(path) !== 'go.work') continue;
    for (const use of parseUseDirs(text)) {
      if (!dirs.has(join(dirOf(path), use))) {
        log.warn(`${path} uses ${use}, which has no readable go.mod`);
      }
    }
  }
  return modules.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}
