import type { Core } from 'cytoscape';
import type { DiffEntry, GraphJson } from '../../graph/types.js';
import { wireControls, renderSummary } from './controls.js';
import { renderDiff as defaultRenderDiff, type RenderDiff } from './diff.js';
import { byId } from './dom.js';
import { createGraphView } from './graph.js';
import { createPanel } from './panel.js';

interface ReportOptions {
  collapseThreshold: number;
}

export interface ReportApi {
  cy: Core;
  /** Opens a node's side panel (expanding its clusters); false when there is no such file. */
  openNode(path: string): boolean;
}

function readJson<T>(id: string): T {
  return JSON.parse(byId(id).textContent ?? 'null') as T;
}

/** Starts the report on the current document. `renderDiff` is replaceable for tests. */
export function start(deps: { renderDiff?: RenderDiff } = {}): ReportApi {
  const graph = readJson<GraphJson>('graph-data');
  const diffs = readJson<DiffEntry[]>('diff-data');
  const options = readJson<ReportOptions>('options-data');
  const changed = graph.nodes.filter((n) => n.changed).length;

  const view = createGraphView(byId('graph'), graph, {
    headless: Boolean(window.__PDG_TEST__),
    collapsed: changed > options.collapseThreshold,
  });
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const openNode = (path: string): boolean => {
    const node = nodes.get(path);
    if (!node) return false;
    view.reveal(path);
    panel.show(node);
    return true;
  };
  const panel = createPanel({
    graph,
    diffs,
    renderDiff: deps.renderDiff ?? defaultRenderDiff,
    onOpen: openNode,
  });

  view.onOpen(openNode);
  renderSummary(graph, openNode);
  wireControls(graph, view);

  const api: ReportApi = { cy: view.cy, openNode };
  window.__prDiffGraph = api;
  return api;
}
