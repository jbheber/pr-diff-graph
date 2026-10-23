# pr-diff-graph — design

Status: awaiting approval · 2026-10-23 · owner: jbheber

## Intent

Large pull requests (50+ files) are hard to review because the reviewer has no map: which files matter, which are leaf changes, and how the changed files lean on each other. `pr-diff-graph` is a GitHub Action that, on such a PR, builds a single self-contained HTML report: a graph of the changed files and their import relationships, with each file's diff one click away, and a short "review these first" list.

It is a **portable tool**: it lives in its own repo (`github.com/jbheber/pr-diff-graph`), is tagged (`v1`, `v1.2.3`), and any repo adopts it with a few lines of workflow. It must not assume anything about the repo it runs in. The Casa Fuente del Prado repos (NestJS backend, React/Vite frontend, both TypeScript, Yarn) are the first test bed, not the target.

## Goals

- Works in any repo with zero configuration: single repo or monorepo, TypeScript/JavaScript, Python, Go in v1.
- A reviewer opening the report understands the shape of a 300-file PR in under a minute.
- New languages are added as one plug-in behind a `LanguageParser` interface, without touching the graph or the report.
- Safe on PRs from forks: it only reads and parses files; it never installs or runs PR code.
- Fast: under 2 minutes for a 300-file PR on `ubuntu-latest`, including checkout.

## Non-goals

- No code review, linting, or judgment of the change itself. It maps; it doesn't grade.
- No semantic analysis beyond imports/references (no call graphs, no type flow).
- No external services, paid APIs, or servers. The report is a file.
- No perfect resolution of every exotic module setup (custom webpack resolvers, Bazel, Python `sys.path` hacks). Unresolved imports are reported, not guessed.

## Anti-goals (it would fail even if it "works")

- **A hairball.** A 500-node graph that renders everything at once and shows nothing. Clustering by directory is the default view, neighbors are off by default.
- **Comment spam.** One sticky comment per PR, updated in place.
- **Running untrusted code**, even indirectly (no `npm install`, no `pip install`, no `go list`, no evaluating config files such as `vite.config.ts` or `jsconfig` written in JS).
- **Failing the PR check because a file didn't parse.** Parsing problems are warnings.
- **A report that needs the internet** to open.

## Constraints

- JavaScript action, TypeScript source, bundled with esbuild (ESM) into a committed `dist/`; @vercel/ncc was dropped because it duplicated the tree-sitter WASM per bundle. ESLint + Prettier, strict TypeScript.
- Runtime: `node24` (**builder's call, departs from the prompt's `node20`**: Node 20 reached end of life in April 2026 and GitHub runners have moved actions to Node 24; `node20` would ship deprecated).
- Permissions: `contents: read`, `pull-requests: write` (plus `actions: read` for the comment workflow of the fork pattern).
- Runner: `ubuntu-latest`; the action must also run locally on Windows/macOS through its CLI (for testing).

## Architecture

```text
action entry (src/main.ts)          CLI entry (src/cli.ts) — same pipeline, no GitHub API
        │
        ▼
1. context       → base SHA, head SHA, PR number, inputs
2. diff          → ChangedFile[]          (git, src/diff/)
3. threshold     → skip if files ≤ min-files (log + outputs, exit 0)
4. repo model    → RepoIndex              (src/repo/: file list at head & base, tsconfigs, workspaces, go.mod, python roots)
5. parse         → RawImport[] per file   (src/parsers/<lang>.ts behind LanguageParser)
6. resolve       → path or unresolved     (src/resolve/<lang>.ts, uses RepoIndex)
7. graph         → GraphJson              (src/graph/: nodes, edges, clusters, cycles, ranking)
8. render        → report.html            (src/report/: template + client bundle + data)
9. publish       → artifact, sticky comment, job summary, outputs  (src/publish/)
```

Every step after 3 is pure with respect to GitHub: it takes a repo path and two SHAs. That is what makes the CLI and the end-to-end test possible.

### 1–2. Diff collection: git, not the REST API

Decision: **`git` against the merge base**, after `actions/checkout` with `fetch-depth: 0`.

- `git merge-base <base> <head>` then `git diff -z --find-renames --numstat` and `git diff -z --find-renames --name-status` for status, old path, +/- counts; `git diff --patch` per file (batched) for the patch text.
- Why not REST `GET /pulls/{n}/files`: caps at 3000 files, omits `patch` for large diffs, and needs network for every page. git has none of those limits and the same code runs in the CLI and tests. REST is used only for the comment.
- File contents are read with `git cat-file --batch` at the **head SHA** (and the merge-base SHA for deleted files and old paths of renames), not from the working tree. The working tree on `pull_request` is the synthetic merge commit; reading by SHA keeps contents consistent with the diff and means nothing in the checkout is executed or even required to be the right ref.
- Binary files (`-` in numstat): node with `binary: true`, no patch, not parsed.
- Statuses: `added | modified | deleted | renamed` (copy and type-change are mapped to `modified`, with the raw status kept).
- Patch cap: per-file patches over `max-patch-bytes` (default 200 KB) are truncated with a marker; the node keeps its true +/- counts.

### 4–6. Parsing and resolution

**Parsing: tree-sitter via `web-tree-sitter` (WASM)** for all v1 languages. Why: one engine, real syntax trees, no native build step (the WASM grammars are vendored into `dist/`), and every future language has a grammar. Grammars: `typescript`, `tsx`, `javascript`, `python`, `go`.

```ts
interface LanguageParser {
  id: string;                           // 'typescript', 'python', 'go'
  extensions: string[];                 // ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
  parse(source: string, path: string): RawImport[];   // may throw → caught, warning, node with no edges
  resolve(imp: RawImport, from: string, repo: RepoIndex): Resolution;
}
interface RawImport { specifier: string; kind: 'static' | 'dynamic' | 'require' | 'type-only' | 'reexport' | 'reference'; line: number; names?: string[]; }
type Resolution = { kind: 'file'; paths: string[] }   // several for a Go package directory
   | { kind: 'external'; name: string } | { kind: 'unresolved'; reason: string };
```

The registry maps extension → parser. Files with no parser still become nodes (with diffs), just without edges. A regex fallback exists per language **only** when the WASM grammar fails to load; it is logged as a warning and documented as lower fidelity (misses imports inside template strings, catches some in comments).

**What each parser extracts**

- TS/JS: `import … from`, `import '…'`, `export … from`, `import type`, dynamic `import('literal')`, `require('literal')`, triple-slash `/// <reference path>`. Non-literal specifiers are ignored.
- Python: `import a.b`, `from a.b import c`, relative `from . import x`, `from ..pkg import y`.
- Go: `import "path"` and grouped imports.

**Resolution (no installs, no evaluating config)**

- TS/JS, in order:
  1. Relative specifiers: exact file, then extension probing (`.ts .tsx .d.ts .js .jsx .mjs .cjs .mts .cts`), then `index.*`, then directory `package.json` `main`. `.js` written in TS source maps to `.ts`/`.tsx` (ESM-in-TS convention).
  2. `tsconfig.json`/`jsconfig.json` `paths` + `baseUrl`, nearest config to the importing file, following `extends` (relative and package-name extends that live in the repo; unresolvable extends are ignored with a warning). Parsed as JSONC. Project `references` are walked to find configs.
  3. Workspace packages: from `package.json` `workspaces` (npm/Yarn) and `pnpm-workspace.yaml`. A specifier `@scope/pkg/sub` resolves to the package dir, then its `exports` (`source`/`types`/`import`/`default` conditions, in that order), then `types`/`main`, then `src/index.*` fallback. Built outputs (`dist/…`) are mapped back to `src/…` when the dist file doesn't exist in git.
  4. Anything else: `external` (bare package from `node_modules`), counted but not drawn.
- Python: relative imports from the file's package; absolute imports against detected roots (repo root, `src/`, and any dir with `pyproject.toml`/`setup.cfg`), as `a/b.py` or `a/b/__init__.py`. Otherwise external.
- Go: module path from every `go.mod` in the repo (and `go.work`); an import with that prefix resolves to the **package directory**, i.e. edges to every non-test `.go` file in that directory. Otherwise external (stdlib or third-party).

Resolution only consults the `RepoIndex` built from `git ls-tree -r <head>` (and `<base>` for deleted files), so it is fast, deterministic, and blind to untracked files.

### 7. Graph

**Nodes** are all changed files, plus (data only, hidden by default) unchanged files that a changed file imports: one hop, outgoing. Incoming neighbors (unchanged files that import a changed file) require parsing the whole repo; that is behind input `scan-repo: true` (off by default), with a file-count cap.

**Edges**: `from` imports `to`. Kinds: `changed→changed` (highlighted), `changed→unchanged`, `unchanged→changed` (only with `scan-repo`). Deleted files are parsed at base, so their edges show what used to depend on what. A deleted file is never a valid target at head; an import of a deleted path from a head file is an `unresolved` import, which is exactly the broken-import signal a reviewer wants, so these are listed separately in the summary.

**Clusters**: by workspace package when the file belongs to one (always the outermost cluster), else by directory, starting from the directory cut at depth `cluster-depth` (default 2; inside a package, counted from the package directory). A cluster whose subtree holds more than 30 nodes (all nodes in `graph.json`, unchanged neighbors included) splits: each immediate subdirectory holding nodes becomes a child cluster, files directly in the directory stay in it; applied recursively. A cluster whose only content is one child cluster is merged into that child (packages are never merged away). A node's `cluster` is its innermost cluster; a cluster's `label` is its directory relative to its parent cluster's (the full path at the top level, so a merged chain reads `src/app/modules`).

**Cycles**: Tarjan SCC on the changed→changed subgraph; every SCC of size > 1 (or a self-loop) is a cycle. The summary reports count and members; edges in a cycle are marked.

**Ranking ("review these first")**: top 10 changed files by changed-degree (in + out among changed files), ties broken by lines changed. Rationale: a file many other changed files depend on is the one whose change explains the others.

**Graph JSON** (embedded in the report and written next to it as `graph.json`; this is also what the e2e test snapshots):

```jsonc
{
  "version": 1,
  "pr": { "number": 123, "base": "<sha>", "head": "<sha>", "mergeBase": "<sha>", "repo": "owner/name" },
  "summary": { "files": 312, "additions": 8211, "deletions": 4120, "edges": 540, "cycles": 2, "unresolved": 7, "parseErrors": 1, "binary": 4 },
  "clusters": [ { "id": "c:packages/api", "label": "packages/api", "parent": null } ],
  "nodes": [
    { "id": "src/a.ts", "path": "src/a.ts", "oldPath": null, "status": "modified", "changed": true,
      "language": "typescript", "cluster": "c:src", "additions": 12, "deletions": 3, "binary": false,
      "parseError": null, "diffRef": 0 }
  ],
  "edges": [ { "from": "src/a.ts", "to": "src/b.ts", "kind": "changed-changed", "importKinds": ["static"], "inCycle": false } ],
  "cycles": [ ["src/a.ts", "src/b.ts"] ],
  "ranking": ["src/b.ts", "…"],
  "unresolved": [ { "from": "src/a.ts", "specifier": "./gone", "line": 4, "reason": "target deleted" } ]
}
```

Patches are **not** in this JSON; they live in a separate `diffs` array (index = `diffRef`), stored in its own `<script type="application/json">` block and read only when a node is opened.

### 8. Report

- **Template kept separate**: `src/report/template.html` (markup + CSS) with placeholders for the client script and the two data blocks. Client code is TypeScript in `src/report/client/`, bundled by esbuild into one IIFE at build time and inlined. The generator only does string substitution (with `</script` escaping) — no logic in the template.
- **Libraries, vendored and inlined**: Cytoscape.js (graph; canvas renderer handles 500+ nodes, compound nodes give clusters natively) with `cytoscape-fcose` (fast force-directed layout that respects compound nodes) and `cytoscape-expand-collapse` (collapse/expand clusters); diff2html (side-by-side/line diffs) with highlight.js core + only the languages we parse plus common config formats (json, yaml, md, css, sql) to keep size down. All MIT/BSD; licenses bundled into a `THIRD_PARTY_NOTICES` comment.
- **View**: header with totals (files, +/−, edges, cycles, unresolved, parse errors) and the top-10 list (clicking one focuses it). Graph in the middle. Side panel on node click: path (and old path), status, +/− counts, incoming and outgoing edges as clickable lists, the diff rendered on demand and cached.
- **Encoding**: color = status (added green, modified blue, deleted red, renamed purple; colors chosen to stay distinguishable for common color-blindness, and status also shown by node shape border so color isn't the only channel); size = lines changed, log-scaled and clamped.
- **Controls**: filename search (highlights + focuses matches), status filter, directory/cluster filter, collapse/expand all and per cluster, "show unchanged neighbors" toggle (off), "show external packages" is not offered (externals are counts only), reset layout, light/dark following the OS.
- **Scale**: above `collapse-threshold` changed files (default 150) the report opens with clusters collapsed, then expands the smallest cluster in view, one at a time, while at most `collapse-threshold` nodes show (so a single huge cluster opens level by level). While clusters are collapsed, all edges between the same two shown endpoints (same direction) are drawn as one edge whose width grows with the count and whose label is the count; it takes the cycle color when any of its edges is in a cycle. Layout runs once and positions are cached; diffs are never rendered until asked. Target: interactive in < 3 s at 500 nodes on a laptop.
- Works from `file://` with no network.

### 9. Publishing

- **Artifact**: uploaded by the action itself with `@actions/artifact` (v2 API), so it can link the exact artifact URL (`…/actions/runs/<run>/artifacts/<id>`) in the comment. Contains `report.html` and `graph.json`. Retention input `artifact-retention-days` (default 14).
- **Sticky comment**: identified by a hidden marker `<!-- pr-diff-graph:v1 -->`; the action lists PR comments, updates the one with the marker or creates it. Content: totals, cycles, unresolved count, top 5 files, link to the artifact and the run. Also written to the job summary (`$GITHUB_STEP_SUMMARY`), which works even when commenting is not allowed.
- **Skipped PRs**: below threshold, no report; if a sticky comment already exists (the PR shrank), it is updated to say the PR is now under the threshold, never deleted.
- **Outputs**: `report-path`, `graph-path`, `files-changed`, `edges-count`, `skipped`.
- **GitHub Pages: not in v1** (owner's decision). Reviewers open the report by downloading the artifact. Pages would make reports public on public repos, needs Enterprise to restrict on private repos, needs `contents: write`, and leaves old `pr-<n>/` folders to clean up.

## Fork security model

- Default and recommended trigger: **`pull_request`**. The workflow runs with the PR's code checked out but a read-only `GITHUB_TOKEN` for fork PRs and no secrets. Since the action only reads git objects, that is safe. Consequence: on fork PRs the comment can't be written; the action detects the 403, warns, and relies on the job summary and artifact.
- To get comments on fork PRs too, the README documents the **two-workflow pattern**: workflow A (`pull_request`, read-only) runs the action with `mode: report` and uploads the artifact plus a small `summary.json`; workflow B (`workflow_run` on A's completion, with `pull-requests: write`) runs the action with `mode: comment`, which downloads only `summary.json`, validates it against a schema, and posts the comment. B never checks out PR code.
- `pull_request_target` is documented as **not recommended**: it runs with a write token and secrets in the base repo's context; it is safe only because this action never executes the checkout, but any other step a user adds to that job would inherit the risk. If someone uses it anyway, they must check out by SHA and not run any other step on that checkout; the README says so plainly.
- The action never reads or executes repo config written in code (`*.config.js`, `vite.config.ts`, `setup.py`); only JSON/JSONC/YAML/TOML-ish manifests are parsed, as data.
- The HTML report escapes all repo-derived text (paths, patches) — a malicious filename or diff must not inject script into the report.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `min-files` | `50` | Skip when changed files ≤ this |
| `mode` | `full` | `full` (report + comment), `report` (no comment), `comment` (comment from a `summary.json` artifact, for the fork pattern) |
| `github-token` | `${{ github.token }}` | Token for comments |
| `comment` | `true` | Post/update the sticky comment |
| `cluster-depth` | `2` | Directory depth for clusters |
| `collapse-threshold` | `150` | Open collapsed above this many nodes |
| `scan-repo` | `false` | Parse the whole repo to find unchanged files that import changed ones |
| `max-patch-bytes` | `200000` | Per-file patch cap in the report |
| `include` / `exclude` | — | Glob lists (newline-separated) applied to changed files; `exclude` defaults to lockfiles and `dist/`-style generated output |
| `artifact-name` | `pr-diff-graph` | Artifact name |
| `artifact-retention-days` | `14` | |

## Repo layout

```text
action.yml
src/
  main.ts  cli.ts  context.ts  inputs.ts
  diff/        git.ts, collect.ts
  repo/        index.ts, tsconfig.ts, workspaces.ts, gomod.ts, python.ts
  parsers/     types.ts (LanguageParser), registry.ts, treesitter.ts, typescript.ts, python.ts, go.ts, regex-fallback.ts
  graph/       build.ts, clusters.ts, cycles.ts, rank.ts, types.ts (GraphJson)
  report/      template.html, render.ts, client/ (TS, bundled with esbuild)
  publish/     artifact.ts, comment.ts, summary.ts, outputs.ts
grammars/      *.wasm (vendored, versions pinned in grammars/VERSIONS)
test/
  unit/        parsers, resolvers, cycles, clusters, rank, render escaping
  fixtures/    fixture repos built by a script into temp git repos (base commit + head commit)
  e2e/         runs the CLI pipeline on a fixture, snapshots graph.json
dist/          esbuild output + grammars + report assets (committed)
.github/workflows/  ci.yml (lint, test, check dist is up to date), pr-diff-graph.yml (example, dogfooding)
README.md
```

## Testing

- **Unit (Vitest)**: per-parser import extraction (each import form above, comments and strings that look like imports, syntax errors → throw); resolution: relative, extensionless, `index` files, `.js`→`.ts`, `paths` with wildcards and multiple targets, `baseUrl`, `extends` chains, workspace packages with `exports`, dist→src mapping, Python relative and `src/` layout, Go multi-module; renames (old path kept, edges computed at head, deleted-target unresolved); cycles; ranking; HTML escaping of hostile filenames/patches.
- **End-to-end**: a fixture repo (monorepo with two TS workspace packages, a tsconfig alias, a Python package, a Go module; base commit + head commit with adds/modifies/deletes/renames, a binary file, a cycle, a file that fails to parse) created by a script in a temp dir; run the pipeline; snapshot `graph.json` (SHAs normalized). Plus a smoke assertion that `report.html` contains no external URLs.
- **Performance**: a generated 300-file fixture run in CI, asserting the pipeline (excluding checkout) finishes under 30 s.
- **Real-world check on Casa Fuente del Prado**: run the CLI locally against a large historical diff in `backend/` and `frontend/` (two refs far enough apart to touch 50+ files), open the report, check the aliases and module structure resolve. Then optionally dogfood on GitHub by adding the example workflow to a CFP repo on a test branch (only with the owner's go-ahead at that point).

## CLI (for local runs and testing)

`node dist/cli.js --repo <path> --base <ref> --head <ref> [--out <dir>] [--min-files N] [--open]` — same pipeline, writes `report.html` and `graph.json`, no GitHub API calls.

## Builder's calls (made by me, not agreed by the owner)

- `node24` instead of `node20`.
- git for diff collection instead of the REST API.
- Tree-sitter WASM for parsing in all languages; regex only as a load-failure fallback.
- Own resolver instead of the TypeScript compiler's `resolveModuleName` (no `node_modules` exist, and workspaces/dist→src mapping need custom logic anyway).
- Cytoscape.js + fcose + expand-collapse over D3 (compound nodes and canvas rendering out of the box).
- Action uploads the artifact itself (to link the exact artifact URL).
- Two-workflow fork pattern via a `mode` input.
- Unchanged incoming neighbors only with `scan-repo`.
- Ranking by changed-degree.

- `min-files` counts files **after** `include`/`exclude`, so a PR that is mostly regenerated lockfiles or `dist/` doesn't trigger a report; `files-changed` reports that filtered count (the raw count goes in the summary).
- Shallow checkouts: the action detects a missing merge base and fetches what it needs itself (`git fetch` of the base SHA, then deepening in steps until `merge-base` resolves, falling back to `--unshallow`), with a warning recommending `fetch-depth: 0`. The 2-minute target counts the action's own run, not the user's clone of a very large repo.
- `mode: comment` is in v1 and treats `summary.json` as hostile: the PR number comes from the `workflow_run` event (its `pull_requests` list, or a lookup by head SHA) and never from the file; the file contributes only numbers and paths, which are validated, length-capped and escaped into the comment. Workflow B needs `actions: read` (to download A's artifact) and `pull-requests: write`, documented in the README.

## Left to the builder

- Exact visual design of the report within the encoding above; exact comment wording.
- Grammar WASM sourcing and pinning (build from grammar repos or take a maintained prebuilt set), as long as the ABI matches `web-tree-sitter`.
- Default `exclude` list.

## Trade-offs to revisit

- If tree-sitter WASM ABI churn becomes a maintenance burden, the TS/JS parser could move to the TypeScript compiler's `preProcessFile`.
- Go edges to every file of a package directory can be noisy for large packages; a later version could narrow to the files that declare the used identifiers.
- `scan-repo` cost on very large monorepos; a later version could cache a repo-wide import index keyed by base SHA.
