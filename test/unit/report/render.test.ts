import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiffEntry, GraphJson, GraphNode } from '../../../src/graph/types.js';
import { embedJson, renderReport, type ReportAssets } from '../../../src/report/render.js';

const HOSTILE_PATH = '</script><img src=x onerror=alert(1)>.ts';
const HOSTILE_PATCH = `diff --git a/x.ts b/x.ts\n+const s = '</script><script>alert(1)</script>';\n`;

function node(path: string, diffRef: number | null): GraphNode {
  return {
    id: path,
    path,
    oldPath: null,
    status: 'modified',
    changed: true,
    language: 'typescript',
    cluster: 'c:src',
    additions: 1,
    deletions: 0,
    binary: false,
    parseError: null,
    diffRef,
  };
}

function graph(prNumber: number | null, paths: string[]): GraphJson {
  return {
    version: 1,
    pr: { number: prNumber, base: 'b', head: 'h', mergeBase: 'm', repo: 'acme/<repo>' },
    summary: {
      files: paths.length,
      additions: paths.length,
      deletions: 0,
      edges: 0,
      cycles: 0,
      unresolved: 0,
      parseErrors: 0,
      binary: 0,
      rawFiles: paths.length,
      externals: 0,
    },
    clusters: [{ id: 'c:src', label: 'src', parent: null }],
    nodes: paths.map((p, i) => node(p, i)),
    edges: [],
    cycles: [],
    ranking: paths,
    unresolved: [],
  };
}

async function assets(): Promise<ReportAssets> {
  const template = await readFile(join(import.meta.dirname, '../../../src/report/template.html'), {
    encoding: 'utf8',
  });
  return {
    template,
    // Hostile-looking but legitimate bundle content: a `</script` in a string literal and `$&`.
    clientJs: 'window.x = "</script>" + "$&";',
    clientCss: 'body{color:red}/* </style> */',
  };
}

/** The text content of `<script ... id="<id>">…</script>`. */
function block(html: string, id: string): string {
  const m = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(
    html,
  );
  if (!m) throw new Error(`no #${id} block`);
  return m[1]!;
}

describe('embedJson', () => {
  it('escapes characters that could end a script block or break JS parsing', () => {
    const s = embedJson({ a: '</script><!-- & \u2028\u2029' });
    expect(s).not.toMatch(/[<>&\u2028\u2029]/);
    expect(s).toContain('\\u003c/script\\u003e');
    expect(JSON.parse(s)).toEqual({ a: '</script><!-- & \u2028\u2029' });
  });
});

describe('renderReport', () => {
  it('embeds graph and diffs as JSON blocks that round-trip', async () => {
    const g = graph(7, ['src/a.ts', 'src/b.ts']);
    const diffs: DiffEntry[] = [
      {
        path: 'src/a.ts',
        patch: 'diff --git a/src/a.ts b/src/a.ts\n+$& $1 $$\n',
        truncated: false,
        binary: false,
      },
      { path: 'src/b.ts', patch: null, truncated: false, binary: true },
    ];
    const html = renderReport(g, diffs, { collapseThreshold: 150 }, await assets());
    expect(JSON.parse(block(html, 'graph-data'))).toEqual(g);
    expect(JSON.parse(block(html, 'diff-data'))).toEqual(diffs);
    expect(JSON.parse(block(html, 'options-data'))).toEqual({ collapseThreshold: 150 });
  });

  it('hostile filename and patch cannot break out', async () => {
    const g = graph(1, [HOSTILE_PATH]);
    const diffs: DiffEntry[] = [
      { path: HOSTILE_PATH, patch: HOSTILE_PATCH, truncated: false, binary: false },
    ];
    const html = renderReport(g, diffs, { collapseThreshold: 150 }, await assets());

    const opens = html.match(/<script\b/g) ?? [];
    const closes = html.match(/<\/script/gi) ?? [];
    expect(opens).toHaveLength(4);
    expect(closes).toHaveLength(4);
    expect(html.match(/<\/style/gi) ?? []).toHaveLength(1);

    // `onerror=alert` only inside the JSON blocks, and there with `<`/`>` escaped.
    const outside = html.replace(
      /<script type="application\/json" id="[a-z-]+">[\s\S]*?<\/script>/g,
      '',
    );
    expect(outside).not.toContain('onerror=alert');
    expect(block(html, 'graph-data')).toContain('\\u003cimg src=x onerror=alert(1)\\u003e');
    expect(block(html, 'diff-data')).not.toContain('<');
    expect(JSON.parse(block(html, 'diff-data'))).toEqual(diffs);
  });

  it('has no network URLs', async () => {
    const html = renderReport(graph(1, ['src/a.ts']), [], { collapseThreshold: 1 }, await assets());
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(html).not.toMatch(/@import/i);
  });

  it('title includes PR number when present', async () => {
    const a = await assets();
    const withPr = renderReport(graph(42, ['a.ts']), [], { collapseThreshold: 1 }, a);
    expect(withPr).toMatch(/<title>[^<]*PR #42[^<]*<\/title>/);
    expect(withPr).toContain('acme/&lt;repo&gt;');
    const without = renderReport(graph(null, ['a.ts']), [], { collapseThreshold: 1 }, a);
    expect(without).toMatch(/<title>[^<#]*<\/title>/);
  });

  it('keeps the client script and style intact apart from closing-tag escaping', async () => {
    const html = renderReport(graph(1, ['a.ts']), [], { collapseThreshold: 1 }, await assets());
    expect(html).toContain('window.x = "<\\/script>" + "$&";');
    expect(html).toContain('body{color:red}/* <\\/style> */');
  });
});
