import type { BlobReader } from '../diff/git.js';
import { git } from '../diff/git.js';
import type { Logger } from '../log.js';
import { findGoModules, type GoModule } from './gomod.js';
import { baseOf, dirOf } from './paths.js';
import { findPythonRoots } from './python.js';
import { loadTsConfigs, type TsConfigInfo } from './tsconfig.js';
import {
  findWorkspaces,
  manifestFields,
  owningPackage,
  parsePackageJsons,
  type PackageManifest,
  type WorkspacePackage,
} from './workspaces.js';

export type { GoModule } from './gomod.js';
export type { TsConfigInfo } from './tsconfig.js';
export type { PackageManifest, WorkspacePackage } from './workspaces.js';

export interface RepoIndex {
  sha: string;
  /** Every file in the tree at `sha`, except those under node_modules/. */
  files: ReadonlySet<string>;
  has(path: string): boolean;
  /** Immediate child files of `dir` ('' = repo root), as repo-relative paths. */
  listDir(dir: string): string[];
  /** UTF-8 content of `path` at `sha`, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  tsconfigs: TsConfigInfo[];
  nearestTsConfig(fromFile: string): TsConfigInfo | null;
  workspaces: WorkspacePackage[];
  packageOf(path: string): WorkspacePackage | null;
  /** Entry-point fields of `dir/package.json`, or null when there is none (or it does not parse). */
  packageManifest(dir: string): PackageManifest | null;
  goModules: GoModule[];
  pythonRoots: string[];
}

const MANIFEST_NAMES = new Set([
  'jsconfig.json',
  'package.json',
  'pnpm-workspace.yaml',
  'go.mod',
  'go.work',
]);

function isManifest(path: string): boolean {
  const b = baseOf(path);
  return MANIFEST_NAMES.has(b) || /^tsconfig.*\.json$/.test(b);
}

export async function buildRepoIndex(
  repo: string,
  sha: string,
  reader: BlobReader,
  log: Logger,
): Promise<RepoIndex> {
  const listing = await git(repo, ['ls-tree', '-r', '--name-only', '-z', sha]);
  const files = new Set(
    listing
      .split('\0')
      .filter(
        (p) =>
          p &&
          p !== 'node_modules' &&
          !p.startsWith('node_modules/') &&
          !p.includes('/node_modules/'),
      ),
  );

  const children = new Map<string, string[]>();
  for (const f of files) {
    const dir = dirOf(f);
    const list = children.get(dir);
    if (list) list.push(f);
    else children.set(dir, [f]);
  }

  const read = async (path: string): Promise<string | null> => {
    const buf = await reader.read(sha, path);
    return buf === null ? null : buf.toString('utf8');
  };

  const stripBom = (t: string) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
  const manifestPaths = [...files].filter(isManifest);
  const texts = await Promise.all(manifestPaths.map(read));
  const manifests = new Map<string, string>();
  manifestPaths.forEach((p, i) => {
    const t = texts[i];
    if (t != null) manifests.set(p, stripBom(t));
  });

  const readManifest = async (path: string): Promise<string | null> =>
    manifests.get(path) ??
    (files.has(path) ? await read(path).then((t) => (t === null ? t : stripBom(t))) : null);

  const packageJsons = parsePackageJsons(manifests, log);
  const workspaces = findWorkspaces(manifests, log, packageJsons);
  const tsconfigs = await loadTsConfigs({ files, readText: readManifest, workspaces, log });
  const tsByDir = new Map(tsconfigs.map((t) => [t.dir, t]));

  return {
    sha,
    files,
    has: (path) => files.has(path),
    listDir: (dir) => [...(children.get(dir) ?? [])],
    read,
    tsconfigs,
    nearestTsConfig(fromFile) {
      let dir = dirOf(fromFile);
      for (;;) {
        const hit = tsByDir.get(dir);
        if (hit) return hit;
        if (dir === '') return null;
        dir = dirOf(dir);
      }
    },
    workspaces,
    packageOf: (path) => owningPackage(workspaces, path),
    packageManifest(dir) {
      const pkg = packageJsons.get(dir);
      return pkg ? manifestFields(pkg) : null;
    },
    goModules: findGoModules(manifests, log),
    pythonRoots: findPythonRoots(files),
  };
}
