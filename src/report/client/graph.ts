import cytoscape, {
  type Core,
  type ElementDefinition,
  type LayoutOptions,
  type NodeSingular,
  type Position,
} from 'cytoscape';
import expandCollapse from 'cytoscape-expand-collapse';
import fcose from 'cytoscape-fcose';
import type { GraphJson, GraphNode } from '../../graph/types.js';
import { nodeSize, readPalette, stylesheet } from './style.js';

cytoscape.use(fcose);
cytoscape.use(expandCollapse);

/** Element id of a file node; the prefix keeps file ids apart from cluster ids (`c:…`). */
export const fileId = (path: string): string => `f:${path}`;

/** The part of cytoscape-expand-collapse's API this report uses (the package has no types). */
interface ExpandCollapse {
  collapseAll(): void;
  expandAll(): void;
  collapse(node: NodeSingular): void;
  expand(node: NodeSingular): void;
  isExpandable(node: NodeSingular): boolean;
  isCollapsible(node: NodeSingular): boolean;
}

export interface GraphView {
  cy: Core;
  collapseAll(): void;
  expandAll(): void;
  /** Expands the collapsed clusters around `path`, then selects and centers it. */
  reveal(path: string): void;
  /** Hides file nodes failing `visible`, and clusters left with no visible file. */
  setVisible(visible: (node: GraphNode) => boolean): void;
  /** Marks these files (or the collapsed clusters holding them) and fits the view to them. */
  highlight(paths: ReadonlySet<string>): void;
  /** Puts every node back where the initial layout placed it. */
  resetLayout(): void;
  onOpen(cb: (path: string) => void): void;
}

function elements(graph: GraphJson, chains: Map<string, string[]>): ElementDefinition[] {
  const out: ElementDefinition[] = [];
  const changedIn = new Map<string, number>();
  for (const n of graph.nodes) {
    if (!n.changed) continue;
    for (const id of chains.get(n.cluster) ?? []) changedIn.set(id, (changedIn.get(id) ?? 0) + 1);
  }
  for (const c of graph.clusters) {
    const count = changedIn.get(c.id) ?? 0;
    out.push({
      group: 'nodes',
      data: {
        id: c.id,
        label: c.label,
        // Shown while the cluster is collapsed.
        countLabel: `${c.label} (${count} ${count === 1 ? 'file' : 'files'})`,
        ...(c.parent ? { parent: c.parent } : {}),
      },
      classes: 'cluster',
    });
  }
  for (const n of graph.nodes) {
    out.push({
      group: 'nodes',
      data: {
        id: fileId(n.id),
        path: n.id,
        label: n.path.slice(n.path.lastIndexOf('/') + 1),
        parent: n.cluster,
        size: nodeSize(n.additions, n.deletions),
      },
      classes: `file status-${n.status}`,
    });
  }
  graph.edges.forEach((e, i) => {
    out.push({
      group: 'edges',
      data: { id: `e${i}`, source: fileId(e.from), target: fileId(e.to) },
      classes: e.inCycle ? `${e.kind} cycle` : e.kind,
    });
  });
  return out;
}

/** Cluster ids from outermost to innermost, for every cluster. */
function clusterChains(graph: GraphJson): Map<string, string[]> {
  const parent = new Map(graph.clusters.map((c) => [c.id, c.parent]));
  const chains = new Map<string, string[]>();
  for (const c of graph.clusters) {
    const chain: string[] = [];
    for (let id: string | null | undefined = c.id; id; id = parent.get(id)) chain.unshift(id);
    chains.set(c.id, chain);
  }
  return chains;
}

export function createGraphView(
  container: HTMLElement,
  graph: GraphJson,
  opts: { headless: boolean; collapsed: boolean },
): GraphView {
  const chains = clusterChains(graph);
  const cy = cytoscape({
    ...(opts.headless ? { headless: true, styleEnabled: true } : { container }),
    elements: elements(graph, chains),
    style: stylesheet(readPalette()),
    minZoom: 0.05,
    maxZoom: 4,
  });

  const layout: LayoutOptions = {
    name: 'fcose',
    animate: false,
    randomize: true,
    quality: 'default',
    nodeRepulsion: () => 6000,
    idealEdgeLength: () => 70,
    packComponents: true,
  } as LayoutOptions;
  /** Fits the viewport to what is shown (an unfitted view opens blank). */
  const fitVisible = () => {
    const shown = cy.elements(':visible');
    cy.fit(shown.nonempty() ? shown : undefined, 30);
  };
  cy.one('layoutstop', fitVisible);
  cy.layout(layout).run();

  // Layout runs once; collapsing, expanding and filtering move nothing.
  const positions = new Map<string, Position>(cy.nodes().map((n) => [n.id(), { ...n.position() }]));
  // Collapsed clusters take their children out of the graph; keep a handle on every element.
  const byId = new Map<string, NodeSingular>(cy.nodes().map((n) => [n.id(), n]));

  if (opts.headless) {
    // The extension always draws its cue canvas into cy.container(), which headless lacks.
    const detached = document.createElement('div');
    cy.container = () => detached;
  }
  const ec = (
    cy as unknown as { expandCollapse(o: Record<string, unknown>): ExpandCollapse }
  ).expandCollapse({
    layoutBy: null,
    fisheye: false,
    animate: false,
    undoable: false,
    cueEnabled: !opts.headless,
    expandCollapseCueSize: 12,
  });
  if (opts.collapsed) ec.collapseAll();
  fitVisible();
  if (!opts.headless) {
    // The container may get its final size only after first layout of the page.
    requestAnimationFrame(() => {
      cy.resize();
      fitVisible();
    });
  }

  cy.on('dbltap', 'node.cluster', (e) => {
    const n = e.target as NodeSingular;
    if (ec.isExpandable(n)) ec.expand(n);
    else if (ec.isCollapsible(n)) ec.collapse(n);
  });

  const media =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
  media?.addEventListener('change', () => cy.style(stylesheet(readPalette())));

  const fileEls = graph.nodes.map((n) => byId.get(fileId(n.id))!);
  const clusterEls = graph.clusters.map((c) => byId.get(c.id)!);
  const nodeByPath = new Map(graph.nodes.map((n) => [n.id, n]));

  /** The outermost collapsed cluster holding `node`, or null when the node itself is in the graph. */
  function collapsedHolder(node: GraphNode): NodeSingular | null {
    for (const id of chains.get(node.cluster) ?? []) {
      const el = byId.get(id);
      if (el?.inside() && ec.isExpandable(el)) return el;
    }
    return null;
  }

  return {
    cy,
    collapseAll() {
      ec.collapseAll();
      fitVisible();
    },
    expandAll() {
      ec.expandAll();
      fitVisible();
    },

    reveal(path) {
      const node = nodeByPath.get(path);
      if (!node) return;
      for (let holder = collapsedHolder(node); holder; holder = collapsedHolder(node)) {
        ec.expand(holder);
      }
      const el = byId.get(fileId(path));
      if (!el?.inside()) return;
      cy.elements(':selected').unselect();
      el.select();
      if (opts.headless) cy.center(el);
      else cy.animate({ center: { eles: el }, duration: 250 });
    },

    setVisible(visible) {
      const shown = new Set<string>();
      graph.nodes.forEach((n, i) => {
        const on = visible(n);
        fileEls[i]!.toggleClass('hidden', !on);
        if (on) for (const id of chains.get(n.cluster) ?? []) shown.add(id);
      });
      for (const el of clusterEls) el.toggleClass('hidden', !shown.has(el.id()));
      fitVisible();
    },

    highlight(paths) {
      for (const el of byId.values()) el.removeClass('match');
      const focus = cy.collection();
      for (const path of paths) {
        const node = nodeByPath.get(path)!;
        const el = collapsedHolder(node) ?? byId.get(fileId(path))!;
        el.addClass('match');
        if (el.inside() && !el.hasClass('hidden')) focus.merge(el);
      }
      if (focus.nonempty()) cy.fit(focus, 60);
    },

    resetLayout() {
      for (const [id, el] of byId) {
        const p = positions.get(id);
        if (p && el.inside() && !el.isParent()) el.position(p);
      }
      fitVisible();
    },

    onOpen(cb) {
      cy.on('tap', 'node.file', (e) => cb((e.target as NodeSingular).data('path') as string));
    },
  };
}
