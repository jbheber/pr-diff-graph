# Mermaid graphs in the sticky comment — design

Status: approved in chat (owner asked for it, 2026-10-23) · builds on `2026-10-23-pr-diff-graph-design.md`

## Intent

The sticky comment gives totals and five file names, but no picture. Reviewers want to see the shape of the PR without downloading the artifact. GitHub renders ```` ```mermaid ```` blocks in comments and job summaries, so the comment can carry two small static graphs. The interactive report stays the place for detail.

## What the comment gains

Two collapsible sections after the totals, each a `<details>` with a one-line `<summary>` and a Mermaid `flowchart LR`:

1. **Overview — "How the changed directories depend on each other".** One box per directory cluster, labelled `<path> · <n> files`. One arrow per ordered cluster pair, labelled with the number of changed→changed imports going across. An arrow whose group contains a cycle edge is red.
2. **Focus — "Most connected files and cycles".** The top 10 ranked files, plus every file in a cycle, up to 25 nodes, labelled with the file name, coloured by status (added, modified, deleted, renamed). Changed→changed edges among them, up to 60, with cycle edges red.

A section is left out when it would say nothing: the overview needs at least 2 boxes and 1 arrow, the focus needs at least 1 edge.

Also fix the plurals in the totals line ("1 cycle", "1 parse error", "1 import edge"…).

## Choosing the overview's boxes

Clusters nest (adaptive clusters from the main design). The overview picks a cut through that tree:

- Start with the top-level clusters.
- While there are fewer than `MAX_BOXES = 12` boxes, replace the box with the most changed files that has child clusters by its children. If it also has files of its own, keep a box for those, labelled `<path> (own files)`. Stop when the next replacement would go over 12 boxes or nothing can be split.
- Each changed file counts toward the box that contains it. Unchanged neighbors are not counted and not drawn.
- Keep the 30 heaviest arrows (count, then ids) and drop self-loops.

## Fork safety: data, never text

In `mode: comment`, `summary.json` comes from a run on fork code, so the comment step never takes Mermaid text from it. Instead:

- `CommentSummary` gains an optional `graphs` field holding structured data only: boxes `{ label, files }`, arrows `{ from, to, count, cycle }` that use array indexes, focus nodes `{ path, status }`, and focus edges `{ from, to, cycle }`.
- The strict zod schema checks:
  - `label` and `path` strings are at most 300 characters.
  - `status` is one of the four statuses.
  - Every list is capped: 12 boxes, 30 arrows, 25 nodes, 60 edges.
  - Every index is an integer that points inside its list.
  - Counts are non-negative integers up to 10,000,000.
- The Mermaid text is generated in `buildSummaryMarkdown` from that validated data. Node ids are generated (`b0…`, `f0…`) and never come from repo data.
- Labels go through `mermaidLabel()`:
  - Keep the end of the path, at most 48 characters, with `…` marking the cut.
  - Keep only `A–Z a–z 0–9 . _ / @ + -` and space. Every other character becomes `_`.
  - Wrap in double quotes.
  - This leaves no way to close the quote, start HTML or markdown, inject a Mermaid directive (`%%{init}%%`) or break out of the code fence. Backticks, `<`, `"`, `%`, `{`, `#`, `;` and newlines all become `_`.
- `graphs` is optional, so a `summary.json` from before this change still parses. `version` stays `1`.

## Where the code goes

- `src/publish/graphs.ts`:
  - `buildCommentGraphs(graph: GraphJson): CommentGraphs | null` picks the boxes, arrows and focus set (pure).
  - `mermaidLabel(s)` escapes labels.
  - `renderGraphSections(g: CommentGraphs): string` emits the two `<details>` blocks.
- `src/publish/summary.ts`:
  - `toCommentSummary` adds `graphs`.
  - The schema gains the `graphs` part, with index range checks via `superRefine`.
  - `toCommentSummary` output must still always pass `parseSummaryJson`.
- `src/publish/comment.ts`: `buildSummaryMarkdown` gets the plural helper and appends `renderGraphSections` when `graphs` is present. The job summary reuses it.
- `README.md`: describe the comment's graphs and add a line to the fork section that the graphs are generated from validated data.

## Tests

- **Box cut:** a nested cluster tree gets split down to at most 12 boxes, keeping an `(own files)` box. Neighbors are not counted. Arrows are aggregated and drop self-loops, a cycle edge marks its arrow red, and arrows are capped at 30 by weight.
- **Focus set:** the top 10 plus cycle members, capped at 25. Edges among them only, capped at 60.
- **`mermaidLabel`:** hostile paths come out with nothing but the allowed characters. Cases: a backtick fence, `"]`, `<img onerror>`, `%%{init: …}%%`, a newline, `#`, `;`, bidi characters, and a long path keeping its end.
- **Rendering:** the output contains `<details>` and ```` ```mermaid ````, red `linkStyle` lines for cycle arrows, status `classDef`s, and no section when there is nothing to show.
- **Schema:** these are rejected: out-of-range indexes, too many boxes, a bad status, extra keys. A `summary.json` without `graphs` still parses. `toCommentSummary` round-trips on the e2e fixture graph.
- **Plurals:** a count of 1 gets the singular, and 0 or 2 get the plural.
- **Size:** a 500-file generated graph produces a comment body under 20,000 characters.
