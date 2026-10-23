# pr-diff-graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A portable GitHub Action (and local CLI) that, for PRs with more than `min-files` changed files, builds a self-contained interactive HTML report of the changed files, their diffs and their import graph, uploads it as an artifact and keeps one sticky PR comment up to date.

**Architecture:** A pure pipeline (git diff → repo index → tree-sitter parse → per-language resolve → graph → HTML) that takes a repo path and two SHAs, wrapped by two thin entries: `src/main.ts` (GitHub Action: inputs, artifact, comment, outputs) and `src/cli.ts` (local runs). Languages are plug-ins behind `LanguageParser`; the report is a separate HTML template plus a client bundle, with data embedded as JSON and diffs rendered lazily.

**Tech Stack:** TypeScript (strict), Node 24, npm, Vitest, ESLint (flat config, typescript-eslint) + Prettier, `@vercel/ncc`, esbuild (report client), `web-tree-sitter` + WASM grammars, `@actions/core`, `@actions/github`, `@actions/artifact`, `picomatch`, `jsonc-parser`, `yaml`, `zod`; report: `cytoscape`, `cytoscape-fcose`, `cytoscape-expand-collapse`, `diff2html`, `highlight.js`.

**Spec:** `docs/superpowers/specs/2026-10-23-pr-diff-graph-design.md` — read it before any task; this plan does not repeat its rules.

## Global Constraints

- `action.yml` uses `runs.using: node24`, `main: dist/index.js`.
- `dist/` is committed and must equal a fresh `npm run build` (CI checks it).
- Never execute repo code or package managers on the analysed repo; only `git` read commands (`merge-base`, `diff`, `ls-tree`, `cat-file`, `fetch`, `rev-parse`). Parse manifests (`package.json`, `tsconfig*.json`/`jsconfig.json` as JSONC, `pnpm-workspace.yaml`, `go.mod`, `go.work`, `pyproject.toml` presence only) as data.
- All file contents come from git objects at a SHA, never the working tree.
- All repo paths inside the pipeline are POSIX, repo-relative, no leading `./`.
- Inputs and defaults exactly as the spec's Inputs table: `min-files` 50, `mode` full, `comment` true, `cluster-depth` 2, `collapse-threshold` 150, `scan-repo` false, `max-patch-bytes` 200000, `artifact-name` pr-diff-graph, `artifact-retention-days` 14. No Pages.
- Outputs: `report-path`, `graph-path`, `files-changed`, `edges-count`, `skipped`.
- Sticky comment marker: `<!-- pr-diff-graph:v1 -->`.
- Parse failures never fail the run: warning + node with `parseError` and no edges.
- The report loads nothing from the network (no `http://` or `https://` in `src=`/`href=`).
- Permissions documented: `contents: read`, `pull-requests: write`; comment workflow of the fork pattern also `actions: read`.
- Unit + e2e via Vitest; `npm test` runs everything; `npm run lint` passes with zero warnings.

## Review Focus

1. **Paths with spaces, unicode, quotes or tabs** — git must be run with `-z` and `-c core.quotepath=off`; such files must appear with their real path. Test in Task 1.
2. **Hostile repo content in the report** — a file named `</script><img src=x onerror=alert(1)>.ts` or a patch containing `</script>` must render as text, never markup. Test in Task 8.
3. **Unusual and unparseable files** — `.vue`, `.json`, `.md`, a minified 2 MB `.js`, a `.ts` with a syntax error: all appear as nodes; none crash the run; huge files are not parsed past 1 MB (`parseError: 'file too large to parse'`). Test in Tasks 3 and 7.
4. **Base not reachable** — shallow checkout or a force-pushed base: the action fetches/deepens; if the merge base still can't be found it fails with a message naming `fetch-depth: 0`, not a git stack trace. Test in Task 1.
5. **Commenting forbidden** (fork PR on `pull_request`, read-only token → 403) — warns, writes the job summary, run still succeeds. Test in Task 9.

---

## File structure

```text
package.json  tsconfig.json  tsconfig.client.json  eslint.config.mjs  .prettierrc  vitest.config.ts  .gitignore  .gitattributes  LICENSE
action.yml
scripts/build.mjs                 ncc main+cli, esbuild client, copy grammars + template into dist/
src/main.ts                       action entry
src/cli.ts                        CLI entry
src/inputs.ts                     typed inputs (action) — parseInputs()
src/pipeline.ts                   runPipeline()
src/log.ts                        Logger interface + console/actions impls
src/diff/git.ts                   git() exec wrapper, BlobReader (cat-file --batch)
src/diff/history.ts               ensureMergeBase()
src/diff/collect.ts               collectDiff()
src/diff/filter.ts                filterFiles(), DEFAULT_EXCLUDE
src/repo/index.ts                 buildRepoIndex(), RepoIndex
src/repo/tsconfig.ts              loadTsConfigs(), TsConfigInfo, nearestTsConfig()
src/repo/workspaces.ts            loadWorkspaces(), WorkspacePackage
src/repo/gomod.ts                 loadGoModules()
src/repo/python.ts                detectPythonRoots()
src/parsers/types.ts              LanguageParser, RawImport, Resolution
src/parsers/treesitter.ts         initTreeSitter(), loadLanguage()
src/parsers/registry.ts           createRegistry(), ParserRegistry
src/parsers/typescript.ts         TS/JS parser (parse + resolve)
src/parsers/python.ts
src/parsers/go.ts
src/parsers/regex-fallback.ts     regex extractors per language
src/graph/types.ts                GraphJson, GraphNode, GraphEdge, DiffEntry, FileImports
src/graph/build.ts                buildGraph()
src/graph/clusters.ts             clusterFor()
src/graph/cycles.ts               findCycles()
src/graph/rank.ts                 rankNodes()
src/report/template.html
src/report/render.ts              renderReport(), loadReportAssets()
src/report/client/main.ts (+ graph.ts, panel.ts, controls.ts, styles.css)
src/publish/summary.ts            CommentSummary, toCommentSummary(), parseSummaryJson()
src/publish/comment.ts            buildCommentBody(), upsertStickyComment()
src/publish/artifact.ts           uploadReport(), downloadSummary()
src/publish/jobsummary.ts         writeJobSummary()
grammars/VERSIONS
test/helpers/gitfixture.ts        makeRepo() — builds temp git repos from file maps
test/unit/**                      per-module tests
test/e2e/pipeline.test.ts  test/e2e/fixture.ts  test/e2e/__snapshots__/
test/perf/pipeline.perf.test.ts
.github/workflows/ci.yml  .github/workflows/pr-diff-graph.yml  examples/fork-comment.yml
README.md
```

---

### Task 1: Repo scaffold, git layer and diff collection

**Files:**
- Create: everything in the scaffold line of the file structure, `src/log.ts`, `src/diff/git.ts`, `src/diff/history.ts`, `src/diff/collect.ts`, `test/helpers/gitfixture.ts`
- Test: `test/unit/diff/collect.test.ts`, `test/unit/diff/history.test.ts`

**Interfaces:**
- Produces:
  - `git(repo: string, args: string[], opts?: { input?: string }): Promise<string>` — `execFile('git', ['-c','core.quotepath=off', ...args])`, `maxBuffer` 512 MB, rejects with `GitError { args, stderr, code }`.
  - `class BlobReader { constructor(repo: string); read(sha: string, path: string): Promise<Buffer | null>; close(): void }` — one long-lived `git cat-file --batch` process; `null` when missing.
  - `ensureMergeBase(repo: string, base: string, head: string, log: Logger): Promise<string>` — returns merge-base SHA.
  - `type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed'`
  - `interface ChangedFile { path: string; oldPath: string | null; status: ChangeStatus; rawStatus: string; additions: number; deletions: number; binary: boolean; patch: string | null; patchTruncated: boolean }` (for deleted files `path` is the old path).
  - `collectDiff(repo: string, mergeBase: string, head: string, opts: { maxPatchBytes: number }): Promise<ChangedFile[]>` sorted by `path`.
  - `interface Logger { info(m: string): void; warn(m: string): void; debug(m: string): void }`, `consoleLogger`, `silentLogger`.
  - Test helper `makeRepo(commits: Array<Record<string, string | Buffer | null>>): Promise<{ dir: string; shas: string[]; cleanup(): Promise<void> }>` — each commit is a file map applied on top of the previous (`null` deletes); renames are expressed as delete+add with identical content.

- [ ] **Step 1: Scaffold.** `git init` in the repo root (the spec file already there). `package.json` (`"type": "module"`, `"engines": {"node": ">=24"}`, scripts `build`, `build:client`, `test` (= `npm run build:client && vitest run`), `lint` (= `eslint . --max-warnings 0 && prettier --check .`), `format`). Strict `tsconfig.json` (`module`/`moduleResolution` `NodeNext`, `target` ES2023). `.gitattributes` with `dist/** -diff linguist-generated` and `* text=auto eol=lf`. `LICENSE` MIT (copyright jbheber). Commit `chore: scaffold`.

- [ ] **Step 2: Write failing tests** in `test/unit/diff/collect.test.ts` using `makeRepo`:
  - `reports added, modified, deleted and renamed files` — base `{a.ts:'x', b.ts:'y', old.ts:'same content\n'.repeat(20)}`, head modifies `a.ts`, deletes `b.ts`, renames `old.ts`→`new/name.ts`, adds `c.ts`. Expect statuses `{a.ts:'modified', b.ts:'deleted', 'new/name.ts':'renamed', c.ts:'added'}` and `oldPath` `'old.ts'` on the rename.
  - `counts additions and deletions` — exact numbers for `a.ts`.
  - `marks binary files and gives them no patch` — `img.png` as a Buffer with NUL bytes → `binary: true, patch: null`.
  - `keeps real paths with spaces, unicode and quotes` — `dir with space/ñandú "q".ts` appears verbatim.
  - `truncates patches over maxPatchBytes` — `maxPatchBytes: 100` on a 5 KB change → `patchTruncated: true`, `patch.length <= 100 + marker`, true `additions` kept.

- [ ] **Step 3: Run** `npx vitest run test/unit/diff` — FAIL (modules missing).

- [ ] **Step 4: Implement** `git`, `BlobReader`, `collectDiff`. Use `git diff -z -M --numstat <mb> <head>` and `-z -M --name-status` joined by path; one `git diff -M --patch <mb> <head> -- <paths…>` per batch of 200 paths, split on `diff --git` headers (match headers by the `-z` path list order, not by parsing the header, to survive odd names). Map `C`/`T` → `modified`, keep raw letter in `rawStatus`.

- [ ] **Step 5: Run** — PASS.

- [ ] **Step 6: Write failing tests** in `test/unit/diff/history.test.ts`:
  - `returns the merge base when history is present`.
  - `deepens a shallow clone until the merge base resolves` — `git clone --depth 1 file://<fixture>` of a 30-commit fixture, then `ensureMergeBase` → correct SHA; logger got a warning containing `fetch-depth: 0`.
  - `fails with an actionable message when the base cannot be fetched` — base SHA that doesn't exist → rejects with message containing `fetch-depth: 0` and the SHA.

- [ ] **Step 7: Implement** `ensureMergeBase`: try `merge-base`; else `fetch --no-tags origin <base> <head>`, then `fetch --deepen=50` up to 5 times, then `fetch --unshallow`; re-try `merge-base` after each.

- [ ] **Step 8: Run** `npx vitest run test/unit/diff` and `npm run lint` — PASS. Commit `feat: collect PR diff from git`.

---

### Task 2: File filter and repo index

**Files:**
- Create: `src/diff/filter.ts`, `src/repo/index.ts`, `src/repo/tsconfig.ts`, `src/repo/workspaces.ts`, `src/repo/gomod.ts`, `src/repo/python.ts`
- Test: `test/unit/diff/filter.test.ts`, `test/unit/repo/*.test.ts`

**Interfaces:**
- Consumes: `git`, `BlobReader`, `ChangedFile`, `makeRepo` (Task 1).
- Produces:
  - `DEFAULT_EXCLUDE: string[]` — `**/package-lock.json`, `**/yarn.lock`, `**/pnpm-lock.yaml`, `**/go.sum`, `**/poetry.lock`, `**/uv.lock`, `**/Cargo.lock`, `**/dist/**`, `**/build/**`, `**/*.min.js`, `**/*.map`, `**/__snapshots__/**`.
  - `filterFiles(files: ChangedFile[], include: string[], exclude: string[]): ChangedFile[]` — picomatch with `dot: true`; a renamed file matches on either path; empty `include` means all; user `exclude` replaces the default only when non-empty.
  - `interface TsConfigInfo { dir: string; baseUrl: string | null; paths: Record<string, string[]> }` (all paths resolved to repo-relative, `extends` already merged).
  - `interface WorkspacePackage { name: string; dir: string; manifest: { main?: string; types?: string; exports?: unknown } }`
  - `interface GoModule { dir: string; modulePath: string }`
  - `interface RepoIndex { sha: string; files: ReadonlySet<string>; has(path: string): boolean; listDir(dir: string): string[]; read(path: string): Promise<string | null>; tsconfigs: TsConfigInfo[]; nearestTsConfig(fromFile: string): TsConfigInfo | null; workspaces: WorkspacePackage[]; packageOf(path: string): WorkspacePackage | null; goModules: GoModule[]; pythonRoots: string[] }`
  - `buildRepoIndex(repo: string, sha: string, reader: BlobReader, log: Logger): Promise<RepoIndex>`

- [ ] **Step 1: Write failing tests:**
  - filter: `excludes lockfiles and dist by default`, `include narrows to globs`, `renamed file matches on old path`, `user exclude replaces default`.
  - tsconfig: `merges extends chain child-over-parent` (`tsconfig.json` extends `./config/base.json` which sets `baseUrl: '..'`, `paths: {'@/*': ['src/*']}` → `baseUrl: ''`, `paths['@/*'] = ['src/*']` relative to repo); `reads JSONC with comments and trailing commas`; `ignores an extends to an uninstalled package with a warning`; `nearestTsConfig picks the closest ancestor` (root + `packages/web/tsconfig.json`); `jsconfig.json is used when no tsconfig exists`.
  - workspaces: `reads npm/yarn workspaces array and object form` (`{packages: [...]}`), `reads pnpm-workspace.yaml`, `expands globs like packages/*`, `packageOf returns the owning package`.
  - gomod: `finds modules in go.mod files and go.work`.
  - python: `roots are repo root, src/ when present, and dirs with pyproject.toml or setup.cfg`.

- [ ] **Step 2: Run** `npx vitest run test/unit/repo test/unit/diff/filter.test.ts` — FAIL.

- [ ] **Step 3: Implement.** `files` from `git ls-tree -r --name-only -z <sha>`. Manifests are read through `BlobReader` up front (all `tsconfig*.json`, `jsconfig.json`, `package.json`, `pnpm-workspace.yaml`, `go.mod`, `go.work`); `read()` is for source files later. Skip any path under `node_modules/`.

- [ ] **Step 4: Run** — PASS. Lint. Commit `feat: build repo index from git tree`.

---

### Task 3: Parser framework, tree-sitter and the TS/JS parser (extraction)

**Files:**
- Create: `src/parsers/types.ts`, `src/parsers/treesitter.ts`, `src/parsers/registry.ts`, `src/parsers/typescript.ts` (parse half), `src/parsers/regex-fallback.ts`, `grammars/VERSIONS`, `scripts/fetch-grammars.mjs`
- Test: `test/unit/parsers/typescript.parse.test.ts`, `test/unit/parsers/registry.test.ts`

**Interfaces:**
- Produces:
  - `interface RawImport { specifier: string; kind: 'static' | 'dynamic' | 'require' | 'type-only' | 'reexport' | 'reference'; line: number; names?: string[] }` (`names` is used by Python `from X import a, b`, Task 4)
  - `type Resolution = { kind: 'file'; paths: string[] } | { kind: 'external'; name: string } | { kind: 'unresolved'; reason: string }` — **`paths` is an array** (Go resolves to a package directory; everything else returns one path).
  - `interface LanguageParser { id: string; extensions: string[]; parse(source: string, path: string): RawImport[]; resolve(imp: RawImport, from: string, repo: RepoIndex): Resolution }`
  - `initTreeSitter(grammarDir: string): Promise<TreeSitterRuntime>`; `TreeSitterRuntime.language(name: 'typescript' | 'tsx' | 'javascript' | 'python' | 'go'): Language | null` (null + warning if load failed).
  - `createRegistry(rt: TreeSitterRuntime, log: Logger): ParserRegistry`; `ParserRegistry.forPath(path: string): LanguageParser | null`; `ParserRegistry.parsers: LanguageParser[]`.
  - `MAX_PARSE_BYTES = 1_000_000`.
  - `regexImports(language: 'typescript' | 'python' | 'go', source: string): RawImport[]`.
  - `grammarDir()` helper: `dist/grammars` at runtime, `<repo>/grammars` in tests.

- [ ] **Step 1: Grammars.** Write `scripts/fetch-grammars.mjs` that copies `tree-sitter.wasm` from `web-tree-sitter` and the five grammar `.wasm` files from a pinned prebuilt source into `grammars/`, and records package names, versions and ABI in `grammars/VERSIONS`. Pick versions whose ABI `web-tree-sitter` accepts; the test in Step 2 proves it. Commit the `.wasm` files.

- [ ] **Step 2: Write failing tests** (`typescript.parse.test.ts`), each asserting `parse()` output as `[{specifier, kind, line}]`:
  - `static imports: default, named, namespace, side-effect` (4 forms, lines 1–4).
  - `type-only imports` → `kind: 'type-only'` for `import type {X} from './t'` (and `import {type X}` stays `static`).
  - `re-exports` → `export * from './a'`, `export {b} from './b'` as `reexport`.
  - `dynamic import with literal only` — `import('./lazy')` captured, `import(name)` ignored.
  - `require with literal only`.
  - `triple-slash reference path` → `reference`.
  - `ignores look-alikes in comments and strings` — `// import x from './no'`, `'import y from "./no"'` → nothing.
  - `parses tsx and jsx` — a `.tsx` component file with JSX and an import.
  - `throws on syntax error` — source with `ERROR` nodes at top level of an import → `parse` throws `ParseError`. (Rule: throw only when the tree has errors **and** no import could be read; otherwise return what was read.)
  - registry: `maps extensions to parsers`, `returns null for .vue/.json/.md`, `falls back to regex when a grammar failed to load` (runtime stub returning null → parser still returns imports, warning logged once).

- [ ] **Step 3: Run** — FAIL.

- [ ] **Step 4: Implement** using tree-sitter queries (`import_statement`, `export_statement` with `source`, `call_expression` whose function is `import` or identifier `require` with a single `string` argument, `comment` matching `/// <reference path=…>`). `.ts/.mts/.cts` use `typescript`, `.tsx` uses `tsx`, `.js/.jsx/.mjs/.cjs` use `tsx` too (JSX in `.js` is common). Delete parse trees after use (WASM memory).

- [ ] **Step 5: Run** — PASS. Lint. Commit `feat: tree-sitter parser framework and TS/JS import extraction`.

---

### Task 4: Python and Go extraction

**Files:**
- Create: `src/parsers/python.ts`, `src/parsers/go.ts` (parse halves; register both)
- Test: `test/unit/parsers/python.parse.test.ts`, `test/unit/parsers/go.parse.test.ts`

**Interfaces:**
- Consumes: Task 3 types and runtime. Python specifiers are dotted strings with leading dots kept (`'..pkg.mod'`). `from X import a, b` is one `RawImport` with `specifier: 'X'`, `names: ['a','b']`; resolution (Task 6) tries each `X.a` as a module first, then falls back to `X`.

- [ ] **Step 1: Write failing tests:**
  - python: `import a.b, c` → `a.b`, `c`; `from a.b import c, d` → specifier `a.b`, `names ['c','d']`; `from . import x` → specifier `.`, names `['x']`; `from ..pkg import y` → `..pkg`; `import inside a function is captured`; `strings and comments ignored`; `.pyi` handled.
  - go: single `import "fmt"`, grouped imports with aliases, dot and blank imports → specifiers only; `_test.go` files still parsed.

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** `feat: Python and Go import extraction`.

---

### Task 5: TS/JS resolution

**Files:**
- Modify: `src/parsers/typescript.ts` (resolve half)
- Test: `test/unit/parsers/typescript.resolve.test.ts`

**Interfaces:**
- Consumes: `RepoIndex` (Task 2), `LanguageParser.resolve`. Tests build indexes from `makeRepo` with one commit.

- [ ] **Step 1: Write failing tests** (each: from-file, specifier → expected `Resolution`):
  - `relative with extension` `./b.ts` → `src/b.ts`.
  - `extensionless` `./b` → `src/b.ts`; prefers `.ts` over `.js` when both exist (order: `.ts .tsx .d.ts .js .jsx .mjs .cjs .mts .cts`).
  - `index file` `./dir` → `src/dir/index.ts`; `./dir/` too.
  - `.js written in TS source maps to .ts` `./b.js` → `src/b.ts` when `src/b.js` absent.
  - `directory with package.json main`.
  - `tsconfig paths wildcard` `@/utils/x` with `'@/*': ['src/*']` → `src/utils/x.ts`.
  - `tsconfig paths multiple targets` falls through to the second target.
  - `baseUrl bare import` `components/Button` with `baseUrl: 'src'` → `src/components/Button.tsx`.
  - `nearest tsconfig wins in a monorepo`.
  - `workspace package root` `@acme/ui` → its `exports['.']` (`source` condition first) → `packages/ui/src/index.ts`.
  - `workspace package subpath` `@acme/ui/button` via `exports['./button']`, and via `exports['./*']` pattern.
  - `workspace dist mapped back to src` — `main: 'dist/index.js'`, no dist in git → `packages/ui/src/index.ts`.
  - `bare external` `react` → `{kind:'external', name:'react'}`; `@scope/pkg/sub` → name `@scope/pkg`; `node:fs` → external `node:fs`.
  - `relative to a missing file` → `unresolved` with reason `not found`.
  - `never returns backslashes` (property test over the cases above).

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** in the spec's order (relative → tsconfig paths/baseUrl → workspaces → external). **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** `feat: resolve TS/JS imports (relative, tsconfig, workspaces)`.

---

### Task 6: Python and Go resolution

**Files:**
- Modify: `src/parsers/python.ts`, `src/parsers/go.ts`
- Test: `test/unit/parsers/python.resolve.test.ts`, `test/unit/parsers/go.resolve.test.ts`

- [ ] **Step 1: Write failing tests:**
  - python: `absolute module file` `app.models` → `app/models.py`; `package __init__` `app` → `app/__init__.py`; `src layout` → `src/app/models.py`; `from-import of a submodule` (`from app import models`, names `['models']`) → `app/models.py`; `from-import of a name` (`from app.models import User`) → `app/models.py`; `relative one and two dots`; `stdlib/third-party` `os`, `requests` → external; `relative beyond root` → unresolved.
  - go: `same-module import resolves to every non-test .go file in the package dir` (`example.com/m/internal/db` → `['internal/db/a.go','internal/db/b.go']`, not `a_test.go`); `multi-module repo picks the longest module prefix`; `stdlib and third-party` → external.

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** `feat: resolve Python and Go imports`.

---

### Task 7: Graph building, pipeline, CLI and end-to-end snapshot

**Files:**
- Create: `src/graph/types.ts`, `src/graph/build.ts`, `src/graph/clusters.ts`, `src/graph/cycles.ts`, `src/graph/rank.ts`, `src/pipeline.ts`, `src/cli.ts`
- Test: `test/unit/graph/*.test.ts`, `test/e2e/fixture.ts`, `test/e2e/pipeline.test.ts`, `test/perf/pipeline.perf.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  - `GraphJson` exactly the spec's JSON shape (`version: 1`), with `summary` also carrying `rawFiles` (count before filtering) and `externals` (count of distinct external names).
  - `interface DiffEntry { path: string; patch: string | null; truncated: boolean; binary: boolean }`
  - `interface FileImports { language: string | null; parseError: string | null; imports: Array<{ imp: RawImport; res: Resolution }> }`
  - `clusterFor(path: string, pkg: WorkspacePackage | null, depth: number): string[]` — chain of cluster ids, outermost first (`c:packages/ui`, then `c:packages/ui/src` when depth allows).
  - `findCycles(nodes: string[], edges: Array<[string, string]>): string[][]` — Tarjan; SCCs of size > 1 plus self-loops; each cycle sorted, list sorted.
  - `rankNodes(nodes: GraphNode[], edges: GraphEdge[], n = 10): string[]`.
  - `buildGraph(args: { pr: GraphJson['pr']; files: ChangedFile[]; imports: Map<string, FileImports>; headIndex: RepoIndex; baseIndex: RepoIndex; clusterDepth: number; rawFiles: number }): { graph: GraphJson; diffs: DiffEntry[] }`
  - `interface PipelineOptions { repo: string; base: string; head: string; outDir: string; minFiles: number; include: string[]; exclude: string[]; clusterDepth: number; collapseThreshold: number; scanRepo: boolean; maxPatchBytes: number; prNumber: number | null; repoSlug: string | null; log: Logger; grammarDir: string; assetsDir: string }`
  - `interface PipelineResult { skipped: boolean; filesChanged: number; rawFilesChanged: number; graph: GraphJson | null; reportPath: string | null; graphPath: string | null; summaryPath: string | null }` — writes `report.html`, `graph.json`, `summary.json` (the `CommentSummary` from Task 9 — until Task 9 lands, Task 7 writes `graph.summary` there and Task 9 swaps in `toCommentSummary`).
  - `runPipeline(opts: PipelineOptions): Promise<PipelineResult>`.
  - CLI: `pr-diff-graph --repo <path> --base <ref> --head <ref> [--out <dir>] [--min-files N] [--scan-repo] [--open]`; refs are resolved with `git rev-parse`; `--open` opens the report with the OS default (`start`/`open`/`xdg-open`); exit code 0 on skip, 1 on error.

- [ ] **Step 1: Write failing unit tests:**
  - cycles: `finds a 3-cycle`, `finds a self-loop`, `two disjoint cycles`, `DAG has none`.
  - clusters: `workspace package is the outer cluster`, `plain dirs collapse to depth 2`, `root files go to cluster c:.`.
  - rank: `orders by changed-degree then lines changed`, `caps at 10`.
  - build: `changed→changed edges are marked`, `outgoing unchanged neighbors are nodes with changed:false`, `deleted files use base edges`, `import of a deleted path becomes unresolved with reason 'target deleted'`, `parse error yields node with parseError and no edges`, `Go package import makes one edge per file`, `duplicate imports of the same target merge importKinds`, `externals are counted not drawn`, `edge inCycle flags`.

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `graph/*`. **Step 4: Run** — PASS.

- [ ] **Step 5: Write the e2e fixture** (`test/e2e/fixture.ts`) — a base and head commit of a monorepo: root `package.json` workspaces `packages/*`; `packages/core` (TS, `exports` with `source`), `packages/web` (TSX, tsconfig `@/*` alias, imports `@acme/core`); `services/py` (Python, `src/` layout, relative imports); `services/go` (go.mod `example.com/svc`, two packages). Head commit has: ≥1 add, modify, delete, rename in each language; a binary `logo.png`; a TS cycle `a→b→c→a`; a `.ts` with a syntax error; a `.vue` file; a file importing a deleted file; a lockfile change (filtered out).

- [ ] **Step 6: Write failing e2e test** `pipeline.test.ts`: run `runPipeline` with `minFiles: 0`; normalize SHAs to `<base>`/`<head>`/`<mb>`; `expect(graph).toMatchSnapshot()`; plus assertions `graph.summary.cycles === 1`, `parseErrors === 1`, `binary === 1`, the lockfile absent, `report.html` exists and contains no `src="http`/`href="http`. And `skips below threshold` — `minFiles: 1000` → `skipped: true`, no files written.

- [ ] **Step 7: Implement `runPipeline`** (order: `ensureMergeBase` → `collectDiff` → `filterFiles` → threshold → indexes at head and merge base → parse/resolve each changed file at head (deleted: at base) with `MAX_PARSE_BYTES` guard, try/catch per file → outgoing unchanged neighbors (no parsing) → `scanRepo` parses every head file with a parser, capped at 20 000 files with a warning → `buildGraph` → `renderReport` (Task 8; until then write `graph.json` only and keep the report assertion `.todo`) → write files). Parse files with a concurrency of 1 (WASM is single-threaded) but read blobs ahead in batches.

- [ ] **Step 8: Run** — PASS; review the snapshot by hand against the fixture before committing it. Implement `src/cli.ts`; check `npx tsx src/cli.ts --repo <fixture dir> --base <base> --head <head> --min-files 0` prints the output paths.

- [ ] **Step 9: Perf test** `pipeline.perf.test.ts` (in its own Vitest project `perf`, run in CI): generated 300-file TS repo with random imports between files; `runPipeline` under 30 000 ms.

- [ ] **Step 10: Commit** `feat: graph builder, pipeline and CLI with e2e snapshot`.

---

### Task 8: HTML report

**Files:**
- Create: `src/report/template.html`, `src/report/render.ts`, `src/report/client/main.ts`, `graph.ts`, `panel.ts`, `controls.ts`, `styles.css`, `tsconfig.client.json`, `scripts/build.mjs` (client part)
- Test: `test/unit/report/render.test.ts`, `test/unit/report/client.test.ts` (jsdom)

**Interfaces:**
- Consumes: `GraphJson`, `DiffEntry` (Task 7).
- Produces:
  - `interface ReportAssets { template: string; clientJs: string; clientCss: string }`, `loadReportAssets(dir: string): Promise<ReportAssets>` (reads `template.html`, `report-client.js`, `report-client.css` from `dist/` or, in tests, from `build/client/` produced by `npm run build:client`).
  - `renderReport(graph: GraphJson, diffs: DiffEntry[], opts: { collapseThreshold: number }, assets: ReportAssets): string`.
  - Template placeholders: `{{TITLE}}`, `{{STYLE}}`, `{{SCRIPT}}`, `{{GRAPH_JSON}}`, `{{DIFFS_JSON}}`, `{{OPTIONS_JSON}}`. Data blocks are `<script type="application/json" id="graph-data">` / `id="diff-data"` / `id="options-data"`.
  - `embedJson(value: unknown): string` — `JSON.stringify` then replace `<` → `\u003c`, `>` → `\u003e`, `&` → `\u0026`, U+2028/2029 escaped.
  - Client exposes nothing global except `window.__prDiffGraph = { cy, openNode(path) }` for tests and debugging.

- [ ] **Step 1: Write failing render tests:**
  - `embeds graph and diffs as JSON blocks that round-trip` (parse them back from the HTML with a regex on the ids, `JSON.parse` equals input).
  - `hostile filename and patch cannot break out` — path `</script><img src=x onerror=alert(1)>.ts`, patch containing `</script><script>alert(1)</script>` → HTML contains exactly one `</script>` per script block, and `onerror=alert` appears only inside a JSON block in escaped form.
  - `has no network URLs` — no `src="http`, `href="http`, no `@import url(http`.
  - `title includes PR number when present`.

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement `render.ts` and `template.html`** (template holds markup + CSS hooks only; no logic beyond placeholders; template replacement uses a function replacer so `$` in data isn't interpreted).

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Write failing client tests** (jsdom, load the rendered HTML of the e2e fixture graph; Cytoscape runs headless with `headless: true` when `window.__PDG_TEST__` is set):
  - `opens collapsed above collapseThreshold` (threshold 1 → all clusters collapsed).
  - `search highlights matching nodes` (`search('core')` → matching nodes have class `match`).
  - `status filter hides deleted nodes`.
  - `neighbors toggle shows unchanged nodes, off by default`.
  - `openNode renders the diff lazily and only once` (diff container empty before, filled after; second open reuses the cached element; render function called once).
  - `side panel lists incoming and outgoing edges as links`.
  - `summary header shows totals, cycle count and top-10 list`.

- [ ] **Step 6: Implement the client** per the spec's View/Encoding/Controls/Scale sections: Cytoscape with `cytoscape-fcose` and `cytoscape-expand-collapse`; compound nodes from `clusters`; node size `clamp(18, 18 + 8*log2(1 + additions + deletions), 72)`; status colors from CSS custom properties (light/dark via `prefers-color-scheme`), with status also as border style (added solid thick, deleted dashed, renamed double, modified solid thin); cycle edges red and thicker; diff2html `Diff2HtmlUI` with highlight.js core + registered `typescript, javascript, python, go, json, yaml, markdown, css, sql, bash, xml`; positions computed once and stored for "reset layout".

- [ ] **Step 7: Run** `npm test` — PASS. Manually open the e2e fixture report from disk with the network disabled (browser devtools offline) and check every control. Flip the e2e `.todo` from Task 7 back on.

- [ ] **Step 8: Commit** `feat: self-contained interactive HTML report`.

---

### Task 9: Action entry, artifact, sticky comment and fork mode

**Files:**
- Create: `action.yml`, `src/main.ts`, `src/inputs.ts`, `src/publish/summary.ts`, `src/publish/comment.ts`, `src/publish/artifact.ts`, `src/publish/jobsummary.ts`, `scripts/build.mjs` (ncc part)
- Test: `test/unit/publish/*.test.ts`, `test/unit/main.test.ts`

**Interfaces:**
- Consumes: `runPipeline`, `PipelineResult` (Task 7).
- Produces:
  - `interface ActionInputs { minFiles: number; mode: 'full' | 'report' | 'comment'; token: string; comment: boolean; clusterDepth: number; collapseThreshold: number; scanRepo: boolean; maxPatchBytes: number; include: string[]; exclude: string[]; artifactName: string; retentionDays: number }`, `parseInputs(get: (name: string) => string): ActionInputs` (rejects bad numbers/modes with the input name in the message).
  - `interface CommentSummary { version: 1; skipped: boolean; minFiles: number; files: number; additions: number; deletions: number; edges: number; cycles: number; unresolved: number; parseErrors: number; top: string[]; headSha: string }` — `top` ≤ 5 paths.
  - `toCommentSummary(result: PipelineResult, minFiles: number, headSha: string): CommentSummary`
  - `parseSummaryJson(raw: string): CommentSummary` — zod schema; numbers non-negative integers ≤ 10 000 000; `top` ≤ 5 strings each ≤ 300 chars; throws on anything else.
  - `buildCommentBody(s: CommentSummary, links: { artifactUrl: string | null; runUrl: string }): string` — starts with `<!-- pr-diff-graph:v1 -->`; every path rendered inside backticks with backticks and `<`/`>` escaped (`` ` `` → `ˋ`, `<` → `&lt;`); skipped variant says the PR is at or under `minFiles` changed files.
  - `upsertStickyComment(octokit, p: { owner: string; repo: string; issueNumber: number; body: string }): Promise<'created' | 'updated'>` — paginate `issues.listComments`, match marker, only comments by the token's user (`github-actions[bot]` or the token owner via `GET /user` fallback to marker only).
  - `uploadReport(files: string[], rootDir: string, name: string, retentionDays: number): Promise<{ id: number; url: string }>` (url = `${server}/${repo}/actions/runs/${runId}/artifacts/${id}`).
  - `downloadSummary(octokit, p: { owner: string; repo: string; runId: number; artifactName: string }): Promise<string>` — finds the artifact by name on that run, downloads the zip, returns `summary.json` text (reject if > 64 KB).
  - `writeJobSummary(s: CommentSummary, links): Promise<void>`.
  - `run(deps: { inputs: ActionInputs; context: typeof github.context; octokit; core; pipeline: typeof runPipeline; upload: typeof uploadReport; download: typeof downloadSummary }): Promise<void>` in `main.ts` (dependency-injected for tests); module bottom calls it with real deps.

- [ ] **Step 1: Write failing tests:**
  - inputs: `defaults match the spec table`, `rejects min-files=abc naming the input`, `newline-separated globs`.
  - summary: `parseSummaryJson rejects extra-large numbers, long paths, wrong version, non-JSON`.
  - comment: `body starts with the marker`, `escapes backticks and angle brackets in paths`, `skipped body`, `upsert updates the existing marker comment` (fake octokit with two pages of comments, marker on page 2 → `updated`, `updateComment` called with its id), `upsert creates when none`.
  - main (`mode: full`): `skips on non-pull_request events with an info log`; `below threshold sets skipped=true and updates an existing comment to the skipped body`; `uploads artifact, comments, sets outputs report-path/graph-path/files-changed/edges-count/skipped`; **`403 on comment warns, writes job summary, does not fail`**; `pipeline error calls core.setFailed with the message`.
  - main (`mode: report`): `never calls the comment API`, artifact includes `summary.json`.
  - main (`mode: comment`): `takes the PR number from workflow_run.pull_requests[0]`; `falls back to searching PRs by head SHA when pull_requests is empty (fork)`; `ignores any PR number in summary.json` (schema has none; extra keys rejected by `.strict()`); `does nothing when the workflow_run concluded with failure`; `rejects an oversized summary`.

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** In `mode: full|report`, base = `pull_request.base.sha`, head = `pull_request.head.sha`, repo = `GITHUB_WORKSPACE`, outDir = `RUNNER_TEMP/pr-diff-graph`.

- [ ] **Step 4: Write `action.yml`** — name, description, branding (`icon: git-pull-request`, `color: blue`), every input with the spec's default and description, the five outputs, `runs: { using: node24, main: dist/index.js }`.

- [ ] **Step 5: Build.** `scripts/build.mjs`: `ncc build src/main.ts -o dist` (→ `dist/index.js`), `ncc build src/cli.ts -o dist/cli` (→ `dist/cli/index.js`), esbuild the client (`--minify --format=iife`) to `dist/report-client.js` + `.css`, copy `src/report/template.html` and `grammars/*.wasm` to `dist/`. Runtime path helpers resolve `grammarDir`/`assetsDir` relative to `import.meta.url` of the bundle. Run `npm run build` and `node dist/cli/index.js --repo <e2e fixture> …` → report written.

- [ ] **Step 6: Run** `npm test && npm run lint` — PASS. Commit `feat: action entry with artifact upload, sticky comment and fork mode` (including `dist/`).

---

### Task 10: CI, example workflows and README

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/pr-diff-graph.yml`, `examples/fork-comment.yml`, `README.md`

- [ ] **Step 1: `ci.yml`** — on push and pull_request: Node 24, `npm ci`, `npm run lint`, `npm test`, `npm run build` then `git diff --exit-code dist/` ("dist is out of date — run npm run build"). Separate job runs the perf project.

- [ ] **Step 2: `pr-diff-graph.yml`** (dogfood + copyable example): `on: pull_request: types: [opened, synchronize, reopened]`; `permissions: contents: read, pull-requests: write`; `concurrency: pr-diff-graph-${{ github.event.pull_request.number }}` with `cancel-in-progress: true`; `actions/checkout@v4` with `fetch-depth: 0`; `uses: ./` (README shows `jbheber/pr-diff-graph@v1`).

- [ ] **Step 3: `examples/fork-comment.yml`** — the two-workflow pattern: A as above with `mode: report`; B `on: workflow_run: workflows: [pr-diff-graph] types: [completed]`, `permissions: actions: read, pull-requests: write`, no checkout, `mode: comment`.

- [ ] **Step 4: README** with sections: what it does (screenshot of the fixture report, `docs/screenshot.png`); quick start; inputs table; outputs; permissions; fork security model (`pull_request` vs two-workflow vs `pull_request_target`, wording from the spec); local CLI; supported languages and resolution rules; limitations (no Pages, no non-literal imports, no custom bundler resolvers, Go package-level edges, `scan-repo` cost, the 1 MB parse cap); adding a language parser (implement `LanguageParser`, add grammar to `fetch-grammars.mjs` + `VERSIONS`, register in `registry.ts`, add `test/unit/parsers/<lang>.*.test.ts`); releasing (`npm run build`, tag `v1.x.y`, move `v1`).

- [ ] **Step 5: Verify** — `npx prettier --check .` passes; validate workflow YAML with `npx action-validator` (or `actionlint` if available). Commit `docs: README, CI and example workflows`.

---

### Task 11: Real-world check on Casa Fuente del Prado (no code in CFP repos)

- [ ] **Step 1:** In `C:\Users\DESKTOP-JUAN\OneDrive\Documents\CasaFuenteDelPrado\backend` and `\frontend`, pick two refs per repo that differ by 50+ files (e.g. `git log --oneline` and a range spanning a few merged PRs; read-only git commands only).

- [ ] **Step 2:** Run `node dist/cli/index.js --repo <cfp repo> --base <old> --head <new> --out <scratch dir> --open` for each.

- [ ] **Step 3:** Check: frontend aliases from its `tsconfig`/`vite` setup resolve (if aliases are defined only in `vite.config.ts`, they show as unresolved — record it as a known limitation, don't evaluate the file); backend NestJS module imports form sensible clusters under `src/`; unresolved count is low and every unresolved entry is explainable; runtime under the budget.

- [ ] **Step 4:** Fix any resolver bug found with a new failing unit test first (same TDD loop), rebuild `dist/`, commit. Record findings in the README's limitations if they are by design.

- [ ] **Step 5 (needs the owner's go-ahead at that point):** create `github.com/jbheber/pr-diff-graph`, push, tag `v1.0.0` + `v1`, and optionally open a test PR in a CFP repo that adds the workflow.
