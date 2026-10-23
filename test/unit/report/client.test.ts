// @vitest-environment jsdom
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cytoscape, { type Core, type NodeSingular } from 'cytoscape';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DiffEntry, GraphJson, GraphNode } from '../../../src/graph/types.js';
import { renderDiff } from '../../../src/report/client/diff.js';
import { start, type ReportApi } from '../../../src/report/client/main.js';
import { loadReportAssets, renderReport } from '../../../src/report/render.js';
import { makeMonorepo, type MonorepoFixture } from '../../e2e/fixture.js';

const ROOT = join(import.meta.dirname, '../../..');
const ASSETS = join(ROOT, 'build', 'client');

let fx: MonorepoFixture;
let out: string;
/** report.html of the e2e fixture, as the CLI wrote it. */
let fixtureHtml: string;
let graph: GraphJson;
let api: ReportApi | null = null;

/** jsdom has no canvas; the expand-collapse extension draws its cues on one even when headless. */
const noCanvas = () => new Proxy({}, { get: () => () => undefined });

/**
 * The fixture report comes from the CLI in a child process: under jsdom, web-tree-sitter takes its
 * browser code path and can't load grammars from disk, so an in-process run would parse differently.
 */
function runCli(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args],
      { cwd: ROOT },
      (err, _stdout, stderr) => (err ? reject(new Error(`cli failed: ${stderr}`)) : resolve()),
    );
  });
}

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = noCanvas as never;
  fx = await makeMonorepo();
  out = await mkdtemp(join(tmpdir(), 'pdg-client-'));
  await runCli([
    '--repo',
    fx.dir,
    '--base',
    'base',
    '--head',
    'main',
    '--out',
    out,
    '--min-files',
    '0',
  ]);
  fixtureHtml = await readFile(join(out, 'report.html'), 'utf8');
  graph = JSON.parse(await readFile(join(out, 'graph.json'), 'utf8')) as GraphJson;
});

afterAll(async () => {
  await fx?.cleanup();
  if (out) await rm(out, { recursive: true, force: true });
});

afterEach(() => {
  api?.cy.destroy();
  api = null;
});

/** Loads the report's markup and data into the test document (without its inline script). */
function load(html: string, options?: { collapseThreshold: number }) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (options) doc.getElementById('options-data')!.textContent = JSON.stringify(options);
  document.body.replaceChildren(
    ...[...doc.body.childNodes].map((n) => document.importNode(n, true)),
  );
  for (const s of document.querySelectorAll('script:not([type])')) s.remove();
}

function startReport(deps: Parameters<typeof start>[0] = {}): ReportApi {
  window.__PDG_TEST__ = true;
  api = start(deps);
  return api;
}

const fileNode = (cy: Core, path: string) => cy.getElementById(`f:${path}`) as NodeSingular;
const shown = (n: NodeSingular) => n.inside() && n.style('display') !== 'none';
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function setChecked(input: HTMLInputElement, checked: boolean) {
  input.checked = checked;
  input.dispatchEvent(new Event('change'));
}

describe('report client', () => {
  it('opens collapsed above collapseThreshold', () => {
    load(fixtureHtml, { collapseThreshold: 1 });
    const { cy } = startReport();
    const top = graph.clusters.filter((c) => c.parent === null).map((c) => cy.getElementById(c.id));
    expect(top.length).toBeGreaterThan(0);
    for (const c of top) expect(c.hasClass('cy-expand-collapse-collapsed-node')).toBe(true);
    expect(cy.nodes('.file')).toHaveLength(0);

    api!.cy.destroy();
    load(fixtureHtml, { collapseThreshold: 150 });
    const expanded = startReport().cy;
    expect(expanded.nodes('.cy-expand-collapse-collapsed-node')).toHaveLength(0);
    expect(expanded.nodes('.file')).toHaveLength(graph.nodes.length);
  });

  it('search highlights matching nodes', () => {
    load(fixtureHtml);
    const { cy } = startReport();
    const search = $<HTMLInputElement>('#search');
    search.value = 'core';
    search.dispatchEvent(new Event('input'));

    const changed = graph.nodes.filter((n) => n.changed);
    const hits = changed.filter((n) => n.path.includes('core'));
    expect(hits.length).toBeGreaterThan(0);
    for (const n of changed) {
      expect(fileNode(cy, n.id).hasClass('match'), n.path).toBe(n.path.includes('core'));
    }
    expect($('#search-count').textContent).toBe(`${hits.length} matches`);

    search.value = '';
    search.dispatchEvent(new Event('input'));
    expect(cy.nodes('.match')).toHaveLength(0);
  });

  it('search marks the collapsed cluster holding a match', () => {
    load(fixtureHtml, { collapseThreshold: 1 });
    const { cy } = startReport();
    const search = $<HTMLInputElement>('#search');
    search.value = 'math.ts';
    search.dispatchEvent(new Event('input'));
    expect(cy.getElementById('c:packages/core').hasClass('match')).toBe(true);
    expect(cy.getElementById('c:services/go').hasClass('match')).toBe(false);
  });

  it('status filter hides deleted nodes', () => {
    load(fixtureHtml);
    const { cy } = startReport();
    const deleted = graph.nodes.filter((n) => n.status === 'deleted');
    const modified = graph.nodes.filter((n) => n.status === 'modified');
    expect(deleted.length).toBeGreaterThan(0);
    for (const n of deleted) expect(shown(fileNode(cy, n.id))).toBe(true);

    setChecked($<HTMLInputElement>('input[name=status][value=deleted]'), false);
    for (const n of deleted) expect(shown(fileNode(cy, n.id))).toBe(false);
    for (const n of modified) expect(shown(fileNode(cy, n.id))).toBe(true);
  });

  it('directory filter keeps only that cluster', () => {
    load(fixtureHtml);
    const { cy } = startReport();
    const select = $<HTMLSelectElement>('#cluster-filter');
    select.value = 'c:services/py';
    select.dispatchEvent(new Event('change'));
    for (const n of graph.nodes.filter((n) => n.changed)) {
      expect(shown(fileNode(cy, n.id)), n.path).toBe(n.path.startsWith('services/py/'));
    }
    expect(shown(cy.getElementById('c:packages/web') as NodeSingular)).toBe(false);
  });

  it('neighbors toggle shows unchanged nodes, off by default', () => {
    load(fixtureHtml);
    const { cy } = startReport();
    const neighbors = graph.nodes.filter((n) => n.status === 'unchanged');
    expect(neighbors.length).toBeGreaterThan(0);
    expect($<HTMLInputElement>('#neighbors').checked).toBe(false);
    for (const n of neighbors) expect(shown(fileNode(cy, n.id))).toBe(false);

    setChecked($<HTMLInputElement>('#neighbors'), true);
    for (const n of neighbors) expect(shown(fileNode(cy, n.id))).toBe(true);
  });

  it('openNode renders the diff lazily and only once', () => {
    load(fixtureHtml);
    const spy = vi.fn(renderDiff);
    const { openNode } = startReport({ renderDiff: spy });
    const diffBox = $('#panel-diff');
    expect(diffBox.childElementCount).toBe(0);
    expect(spy).not.toHaveBeenCalled();

    const path = 'packages/core/src/math.ts';
    expect(openNode(path)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect($('#panel').hidden).toBe(false);
    expect($('#panel-path').textContent).toBe(path);
    expect(diffBox.querySelector('.d2h-wrapper')).not.toBeNull();
    expect(diffBox.textContent).toContain('export const sub');
    const first = diffBox.firstElementChild;

    openNode('services/go/main.go');
    expect(spy).toHaveBeenCalledTimes(2);
    openNode(path);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(diffBox.firstElementChild).toBe(first);
    expect(openNode('no/such/file.ts')).toBe(false);
  });

  it('openNode expands the collapsed clusters around the node', () => {
    load(fixtureHtml, { collapseThreshold: 1 });
    const { cy, openNode } = startReport();
    openNode('packages/web/src/cycle/a.ts');
    const node = fileNode(cy, 'packages/web/src/cycle/a.ts');
    expect(node.inside()).toBe(true);
    expect(node.selected()).toBe(true);
    expect(cy.getElementById('c:services/go').hasClass('cy-expand-collapse-collapsed-node')).toBe(
      true,
    );
  });

  it('side panel lists incoming and outgoing edges as links', () => {
    load(fixtureHtml);
    const { openNode } = startReport();
    openNode('packages/web/src/cycle/b.ts');
    const texts = (sel: string) =>
      [...document.querySelectorAll(`${sel} .pdg-link`)].map((b) => b.textContent);
    expect(texts('#panel-in')).toEqual(['packages/web/src/cycle/a.ts']);
    expect(texts('#panel-out')).toEqual(['packages/web/src/cycle/c.ts']);
    expect($('#panel-in-count').textContent).toBe('1');

    $<HTMLButtonElement>('#panel-out .pdg-link').click();
    expect($('#panel-path').textContent).toBe('packages/web/src/cycle/c.ts');
  });

  it('summary header shows totals, cycle count and top-10 list', () => {
    load(fixtureHtml);
    startReport();
    const total = (key: string) => $(`#totals [data-total="${key}"]`).textContent;
    expect(total('files')).toBe(`${graph.summary.files} files`);
    expect(total('lines')).toBe(`+${graph.summary.additions} −${graph.summary.deletions} lines`);
    expect(total('edges')).toBe(`${graph.summary.edges} imports between files`);
    expect(total('cycles')).toBe('1 cycle');
    expect(total('unresolved')).toBe(`${graph.summary.unresolved} unresolved imports`);
    expect(total('parse-errors')).toBe('1 parse error');
    // The CLI has no PR number or repo slug.
    expect($('#title').textContent).toBe(
      `Diff · ${fx.mergeBase.slice(0, 7)}…${fx.head.slice(0, 7)}`,
    );

    const top = [...document.querySelectorAll('#top-list li')].map((li) => li.textContent);
    expect(top).toEqual(graph.ranking.slice(0, 10));
    expect($('#cycle-list').textContent).toContain('packages/web/src/cycle/a.ts');
    expect($('#unresolved-list').textContent).toContain('../../core/src/legacy');

    $<HTMLButtonElement>('#top-list .pdg-link').click();
    expect($('#panel-path').textContent).toBe(graph.ranking[0]);
  });

  it('renders a hostile file name and patch as text', () => {
    const path = '</script><img src=x onerror=alert(1)>.ts';
    const oldPath = '<svg onload=alert(3)>.ts';
    const patch = [
      `diff --git a/${oldPath} b/${path}`,
      `--- a/${oldPath}`,
      `+++ b/${path}`,
      `@@ -1 +1 @@`,
      `-const a = 1;`,
      `+const s = '</script><script>alert(1)</script><img src=x onerror=alert(2)>';`,
      '',
    ].join('\n');
    loadGraph(
      {
        ...singleFile(path, '<b>root</b>'),
        unresolved: [{ from: path, specifier: '<img src=x>', line: 1, reason: 'not found' }],
      },
      [{ path, patch, truncated: false, binary: false }],
      { oldPath, status: 'renamed' },
    );
    const { openNode } = startReport();
    openNode(path);

    expect($('#panel-path').textContent).toBe(path);
    expect($('#panel-old-path').textContent).toBe(`was ${oldPath}`);
    expect($('#panel-diff').textContent).toContain("'</script><script>alert(1)</script>");
    // diff2html's own icons are `svg`s; none may carry a handler.
    expect(document.body.querySelectorAll('img, b, [onload], [onerror]')).toHaveLength(0);
    expect(document.body.querySelectorAll('script:not([type])')).toHaveLength(0);
  });

  it.each([
    ['packages/web/src/Header.vue', '<template><h1>acme</h1></template>'],
    ['services/py/pyproject.toml', 'name = "svc"'],
  ])('renders the diff of %s (no registered highlighter)', (path, line) => {
    const patch = [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${path}`,
      '@@ -0,0 +1 @@',
      `+${line}`,
      '',
    ].join('\n');
    loadGraph(singleFile(path, 'root'), [{ path, patch, truncated: false, binary: false }]);
    const { openNode } = startReport();
    openNode(path);
    expect($('#panel-diff .d2h-wrapper')).not.toBeNull();
    expect($('#panel-diff .pdg-raw')).toBeNull();
    expect($('#panel-diff').textContent).toContain(line);
  });

  it('falls back to the raw patch when the diff view fails, never showing a stale diff', () => {
    load(fixtureHtml);
    const failing = 'packages/web/src/App.tsx';
    const { openNode } = startReport({
      renderDiff: (target, patch) => {
        if (patch.includes(failing)) throw new Error('boom');
        renderDiff(target, patch);
      },
    });
    openNode('packages/core/src/math.ts');
    expect($('#panel-diff').textContent).toContain('export const sub');

    openNode(failing);
    const diffBox = $('#panel-diff');
    expect(diffBox.textContent).not.toContain('export const sub');
    expect(diffBox.textContent).toContain('Diff view failed (boom)');
    expect($('#panel-diff .pdg-raw').textContent).toContain("import { a } from './cycle/a';");
  });

  it('fits the viewport once the initial layout stops', () => {
    load(fixtureHtml);
    const proto = Object.getPrototypeOf(cytoscape({ headless: true })) as Core;
    const fit = vi.spyOn(proto, 'fit');
    try {
      const { cy } = startReport();
      // First fit: on layoutstop, before the filters hide the unchanged neighbors, so every
      // element is in it. Last fit: after the filters, on what is shown now.
      expect(fit.mock.calls[0]![0]?.length).toBe(cy.elements().length);
      expect(fit.mock.calls.at(-1)![0]?.length).toBe(cy.elements(':visible').length);
      expect(cy.elements(':visible').length).toBeLessThan(cy.elements().length);
      expect(cy.pan()).not.toEqual({ x: 0, y: 0 });
    } finally {
      fit.mockRestore();
    }
  });

  it('labels file nodes with their basename and collapsed clusters with a file count', () => {
    load(fixtureHtml, { collapseThreshold: 1 });
    const { cy, openNode } = startReport();
    const core = cy.getElementById('c:packages/core') as NodeSingular;
    const changedInCore = graph.nodes.filter(
      (n) => n.changed && n.path.startsWith('packages/core/'),
    );
    expect(core.style('label')).toBe(`packages/core (${changedInCore.length} files)`);
    openNode('packages/core/src/fmt/format.ts');
    expect(fileNode(cy, 'packages/core/src/fmt/format.ts').style('label')).toBe('format.ts');
  });
});

/** A graph with one changed file at `path` in a root cluster labelled `label`. */
function singleFile(path: string, label: string): GraphJson {
  return {
    ...graph,
    clusters: [{ id: 'c:.', label, parent: null }],
    nodes: [{ ...graph.nodes[0]!, id: path, path, cluster: 'c:.', diffRef: 0 }],
    edges: [],
    cycles: [],
    ranking: [path],
    unresolved: [],
  };
}

/** Renders `g` and `diffs` into the fixture report's template and loads it. */
function loadGraph(g: GraphJson, diffs: DiffEntry[], node: Partial<GraphNode> = {}) {
  const withNode = { ...g, nodes: g.nodes.map((n) => ({ ...n, ...node })) };
  const template = fixtureHtml.replace(
    /<script type="application\/json" id="(graph|diff)-data">[\s\S]*?<\/script>/g,
    (_m, id: string) =>
      `<script type="application/json" id="${id}-data">{{${id === 'graph' ? 'GRAPH' : 'DIFFS'}_JSON}}</script>`,
  );
  load(
    renderReport(
      withNode,
      diffs,
      { collapseThreshold: 150 },
      { template, clientJs: '', clientCss: '' },
    ),
  );
}

describe('bundled report', () => {
  it('runs from the inlined script with no errors and no network', async () => {
    const assets = await loadReportAssets(ASSETS);
    const errors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (e) => errors.push(e.message));
    virtualConsole.on('error', (e: unknown) => errors.push(String(e)));
    const dom = new JSDOM(fixtureHtml, {
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse(w) {
        (w as unknown as Window).__PDG_TEST__ = true;
        w.HTMLCanvasElement.prototype.getContext = noCanvas as never;
      },
    });
    const w = dom.window as unknown as Window;
    expect(errors).toEqual([]);
    expect(assets.clientJs.startsWith('/*! THIRD_PARTY_NOTICES')).toBe(true);
    expect(w.__prDiffGraph!.cy.nodes('.file')).toHaveLength(graph.nodes.length);
    expect(w.__prDiffGraph!.openNode('packages/core/src/math.ts')).toBe(true);
    expect(w.document.querySelector('#panel-diff .d2h-wrapper')).not.toBeNull();
    w.__prDiffGraph!.cy.destroy();
    dom.window.close();
  });
});
