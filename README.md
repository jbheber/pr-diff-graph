# pr-diff-graph

A GitHub Action (and local CLI) that turns a large pull request into one self-contained HTML report: a graph of the changed files and their import relationships, each file's diff one click away, and a short "review these first" list.

A reviewer of a 300-file PR has no map: which files matter, which are leaf changes, how the changed files lean on each other. The report gives them that map. It maps; it does not grade. There is no code review, linting or judgment of the change.

- Zero configuration: single repo or monorepo; TypeScript/JavaScript, Python and Go.
- Files are clustered by workspace package or directory, so a big PR is not a hairball.
- One sticky comment per PR, updated in place, plus a job summary and a downloadable artifact.
- Safe on fork PRs: it only reads git objects. It never installs dependencies or runs PR code.
- The report is a single file that works from `file://` with no network.

## Quick start

```yaml
# .github/workflows/pr-diff-graph.yml
name: pr-diff-graph

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: pr-diff-graph-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: jbheber/pr-diff-graph@v1
```

On a PR with more than 50 changed files the action comments with the totals, cycles, unresolved imports and the top files to review first, and links the `pr-diff-graph` artifact. Download it and open `report.html`.

The comment (and the job summary) also carries two collapsible Mermaid graphs, which GitHub renders in place:

- **Overview**: one box per changed directory (`<path> · <n> files`, at most 12, splitting the busiest directories while there is room) and one arrow per pair of directories, labelled with the number of imports between their changed files. Arrows that carry an import cycle are red.
- **Focus**: the 10 most connected changed files plus the files in cycles (at most 25), coloured by status (added, modified, deleted, renamed), with the imports among them. Cycle edges are red.

A graph with nothing to show is left out. The interactive report remains the place for detail.

A PR with `min-files` (default 50) changed files or fewer is skipped: no report and no new comment, but if a sticky comment already exists (the PR shrank) it is updated to say the PR was skipped.

`fetch-depth: 0` is recommended. With a shallow checkout the action fetches the base and deepens until it finds the merge base, and warns.

## Inputs

| Input                     | Default               | Meaning                                                                                                                                                                                                                                                                                               |
| ------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `min-files`               | `50`                  | Skip when the changed files (after `include`/`exclude`) are at most this many.                                                                                                                                                                                                                        |
| `mode`                    | `full`                | `full`: report and comment. `report`: no comment (the `pull_request` half of the fork pattern). `comment`: comment from the `summary.json` artifact of the triggering run (the `workflow_run` half).                                                                                                  |
| `github-token`            | `${{ github.token }}` | Token for comments and, in comment mode, for downloading the artifact.                                                                                                                                                                                                                                |
| `comment`                 | `true`                | Post or update the sticky comment on the pull request.                                                                                                                                                                                                                                                |
| `cluster-depth`           | `2`                   | Starting directory depth for clusters (1 to 100). A cluster holding more than 30 files (unchanged neighbors included) splits into one nested cluster per subdirectory, recursively; a directory whose only content is one subdirectory is merged into it (`src/app/modules`).                         |
| `collapse-threshold`      | `150`                 | Above this many changed files the graph opens with clusters collapsed, then the smallest clusters expanded while at most this many nodes show. Edges between two collapsed clusters are drawn as one, labelled with their count.                                                                      |
| `scan-repo`               | `false`               | Parse the whole repo to find unchanged files that import changed ones.                                                                                                                                                                                                                                |
| `max-patch-bytes`         | `200000`              | Per-file patch cap in the report; longer patches are truncated with a marker.                                                                                                                                                                                                                         |
| `include`                 | empty                 | Globs (one per line) of changed files to keep; empty keeps all.                                                                                                                                                                                                                                       |
| `exclude`                 | empty                 | Globs (one per line) of changed files to drop; empty uses the built-in list: lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `go.sum`, `poetry.lock`, `uv.lock`, `Cargo.lock`), `dist/`, `build/`, `*.min.js`, `*.map` and `__snapshots__/`. A non-empty `exclude` replaces that list. |
| `artifact-name`           | `pr-diff-graph`       | Name of the report artifact. Mode `report` also uploads `summary.json` alone as `<name>-summary`, which mode `comment` downloads.                                                                                                                                                                     |
| `artifact-retention-days` | `14`                  | Days to keep the artifact (1 to 90).                                                                                                                                                                                                                                                                  |

## Outputs

| Output          | Meaning                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| `report-path`   | Path of `report.html` (empty when skipped).                                        |
| `graph-path`    | Path of `graph.json` (empty when skipped).                                         |
| `files-changed` | Changed files after `include`/`exclude`.                                           |
| `edges-count`   | Import edges in the graph.                                                         |
| `skipped`       | `true` when the PR is at or under `min-files`, or the event is not a pull request. |

## Permissions

```yaml
permissions:
  contents: read # checkout
  pull-requests: write # the sticky comment
```

- `mode: full` needs the two above. Without `pull-requests: write` the action still produces the artifact and job summary and only warns that it could not comment.
- `mode: comment` (the fork pattern) runs without a checkout and needs `actions: read`, to download the artifact of the triggering run, and `pull-requests: write`.

## Fork pull requests

On a `pull_request` from a fork, GitHub gives the workflow a read-only token and no secrets. There are three ways to deal with that.

### `pull_request` (default, recommended)

The workflow runs with the PR's code checked out but a read-only token. That is safe, because the action only reads git objects. The consequence is that it cannot comment: it detects the 403, warns, and the report remains available in the job summary and the artifact. Nothing else is needed.

### Two workflows: report, then comment

To get the sticky comment on fork PRs too, split the job in two:

1. **Workflow A** ([`examples/fork-report.yml`](examples/fork-report.yml)) runs on `pull_request` with a read-only token and `mode: report`. It uploads the report artifact and a small `<artifact-name>-summary` artifact holding `summary.json`.
2. **Workflow B** ([`examples/fork-comment.yml`](examples/fork-comment.yml)) runs on `workflow_run` when A completes, in the context of the base repo, with `actions: read` and `pull-requests: write`. It runs the action with `mode: comment`. It has no checkout and never runs PR code.

Workflow A's `name` must match the `workflows:` entry of B (`pr-diff-graph (report)` in the examples).

Mode `comment` treats everything from the triggering run as hostile and binds the comment to that run:

- The run must be a successful `pull_request` run; otherwise the action does nothing.
- The PR number comes from the `workflow_run` event (its `pull_requests` list, or a lookup of the open PR with the run's head SHA, repo and branch), never from the file.
- The PR must be open, target this repo, and its current head SHA must equal the run's head SHA (checked again with the API before commenting).
- `summary.json` is validated against a schema, its numbers and paths are length-capped and escaped into the comment, and its `headSha` must equal the triggering run's head SHA.
- The comment's graphs are generated from schema-validated structured data (capped lists, in-range indexes, known statuses, labels reduced to a safe character set), never from Mermaid or other text in `summary.json`.

If the checks fail or more than one PR matches, the action warns and does not comment.

### `pull_request_target` (not recommended)

It runs with a write token and secrets in the base repo's context. This action is safe under it only because it never executes the checkout, but any other step you add to that job inherits the risk. If you use it anyway, check out by SHA (`ref: ${{ github.event.pull_request.head.sha }}`) and run no other step on that checkout. Prefer the two-workflow pattern.

## Tokens

- `GITHUB_TOKEN` (the default) is enough.
- A personal access token also works, for example to comment as a user. Pass it as `github-token`.
- Known limitation: the action updates only a comment authored by the token's own user (a PAT) or by `github-actions[bot]` (`GITHUB_TOKEN`). A GitHub App installation token therefore creates a new comment on every run instead of updating the previous one.

## Local CLI

The same pipeline runs without GitHub, for trying it on any repo or for debugging. It needs Node 24 and a git history that contains both refs.

```bash
node dist/cli/index.js --repo <path> --base <ref> --head <ref> [--out <dir>] [--min-files N] [--scan-repo] [--open]
```

| Option        | Default         | Meaning                                              |
| ------------- | --------------- | ---------------------------------------------------- |
| `--repo`      | `.`             | Git repository to analyse.                           |
| `--base`      |                 | Base branch or commit (required).                    |
| `--head`      |                 | Head branch or commit (required).                    |
| `--out`       | `pr-diff-graph` | Output directory for `report.html` and `graph.json`. |
| `--min-files` | `50`            | Skip when changed files are at most this many.       |
| `--scan-repo` | off             | Parse the whole repo to find unchanged importers.    |
| `--open`      | off             | Open the report when done.                           |

For a small diff pass `--min-files 0`. The CLI prints the paths it wrote and makes no GitHub API calls.

## Supported languages and resolution rules

Parsing uses tree-sitter (WASM grammars vendored in `dist/grammars`). Nothing is installed or evaluated: only JSON, JSONC and YAML manifests are read, as data.

**TypeScript and JavaScript** (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`). Extracted: `import … from`, `import '…'`, `export … from`, `import type`, dynamic `import('literal')`, `require('literal')` and `/// <reference path>`. Resolved in order:

1. Relative specifiers: exact file, extension probing, `index.*`, then the directory's `package.json` `main`. A `.js` written in TS source maps to `.ts`/`.tsx`.
2. `tsconfig.json`/`jsconfig.json` `paths` and `baseUrl`, using the nearest config to the importing file, following `extends` and project `references`.
3. Workspace packages from `package.json` `workspaces` and `pnpm-workspace.yaml`: the package's `exports` (`source`, `types`, `import`, `default`), then `types`/`main`, then `src/index.*`. Built `dist/…` paths are mapped back to `src/…` when the built file is not in git.
4. Anything else is an external package: counted, not drawn.

**Python** (`.py`). Extracted: `import a.b`, `from a.b import c`, and relative imports. Relative imports resolve from the file's package; absolute ones against the repo root, `src/`, and any directory with `pyproject.toml` or `setup.cfg`, as `a/b.py` or `a/b/__init__.py`. Otherwise external.

**Go** (`.go`). Extracted: single and grouped `import`. The module path comes from every `go.mod` (and `go.work`) in the repo; an import under it resolves to the package directory, with an edge to every non-test `.go` file in it. Everything else is external.

Files without a parser (for example Markdown, JSON, Rust) still appear as nodes with their diff, but without edges. Resolution only consults `git ls-tree` of the head (and the base, for deleted files), so it is deterministic and blind to untracked files. An import of a file deleted by the PR is listed as unresolved ("target deleted"), the broken-import signal a reviewer wants.

## Limitations

- No GitHub Pages publishing. Reviewers download the artifact. (Pages would make reports public on public repos and needs `contents: write`.)
- Only literal specifiers are followed: `import(variable)` and `require(expr)` are ignored.
- No custom bundler resolvers. Aliases defined only in `vite.config.ts` or webpack config are not read (those files are code and are never evaluated); use `paths` in `tsconfig.json` or `jsconfig.json`. Unresolved imports are reported, not guessed.
- Go edges are package-level: an import links to every non-test file of the package directory, which can be noisy for large packages.
- Incoming edges from unchanged files need `scan-repo: true`, which parses every parseable file in the repo (capped at 20,000 files). On a very large monorepo it costs real time.
- Files over 1 MB are not parsed; the node is marked "file too large to parse".
- Files that fail to parse are warnings, not failures: the node appears without edges.
- Files with no parser (and binary files) appear as nodes without edges; binary files have no diff either.
- If a WASM grammar fails to load, a regex fallback is used for that language. It is lower fidelity and logged as a warning.
- A GitHub App installation token creates a new comment on every run (see Tokens).
- Two jobs that use the action in the same workflow run must set distinct `artifact-name`s; artifact names are unique per run.

## Adding a language parser

A language is one plug-in behind the `LanguageParser` interface in `src/parsers/types.ts`; the graph and report do not change.

1. Implement `LanguageParser`: `id`, `extensions`, `parse(source, path)` returning `RawImport[]` (throw `ParseError` if the source cannot be read at all), and `resolve(imp, from, repo)` returning a `Resolution`. `src/parsers/go.ts` and `src/parsers/go-resolve.ts` are a compact model.
2. Add the grammar to `scripts/fetch-grammars.mjs` (and the grammar package to `devDependencies`), then run `npm run grammars` to copy the WASM into `grammars/` and update `grammars/VERSIONS`.
3. Register the parser in `src/parsers/registry.ts`.
4. Add tests in `test/unit/parsers/<lang>.parse.test.ts` and `<lang>.resolve.test.ts`.

## Development

Node 24 and npm.

| Script                 | Does                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| `npm test`             | Builds the report client and runs the unit and end-to-end tests.          |
| `npm run test:perf`    | Runs the performance project (a generated 300-file fixture).              |
| `npm run lint`         | ESLint with zero warnings, then `prettier --check`.                       |
| `npm run format`       | `prettier --write`.                                                       |
| `npm run grammars`     | Copies the pinned tree-sitter runtime and grammar WASMs into `grammars/`. |
| `npm run build:client` | Builds the report client into `build/client`.                             |
| `npm run build`        | Type-checks, then bundles the action and CLI with esbuild into `dist/`.   |

The action and the CLI are bundled as ESM by esbuild (`scripts/build.mjs`) into the committed `dist/`, together with the grammars and the report assets. CI fails if `dist/` is out of date.

## Releasing

1. `npm run build` and commit the updated `dist/`.
2. Tag the release `v1.x.y` and push the tag.
3. Move the `v1` tag to it: `git tag -f v1 v1.x.y && git push -f origin v1`.

Users reference `jbheber/pr-diff-graph@v1`.

## License

MIT.
