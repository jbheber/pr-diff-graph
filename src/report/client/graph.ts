import cytoscape, {
  type Core,
  type EdgeSingular,
  type ElementDefinition,
  type Layouts,
  type LayoutOptions,
  type NodeSingular,
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

/** Side of a collapsed cluster holding `files` changed files: bigger than a file node. */
export const collapsedSize = (files: number): number =>
  Math.min(90, Math.max(28, 20 + 6 * Math.sqrt(files)));

/** Width of an edge standing for `count` file edges. */
export const aggregateWidth = (count: number): number => Math.min(8, 1 + 1.5 * Math.log2(count));

/**
 * The clusters to expand when a big graph opens collapsed, in order (parents first).
 *
 * Rule: start with every cluster collapsed; then, while it keeps at most `threshold` nodes on
 * screen, expand the smallest collapsed cluster in view (fewest changed files, then by id).
 * Expanding a cluster shows its own changed files and its child clusters (still collapsed), so
 * a single huge top cluster opens level by level instead of staying one blob. Stops when no
 * cluster in view fits. Only changed files count: unchanged neighbors start hidden.
 */
export function clustersToExpand(graph: GraphJson, threshold: number): string[] {
  const parent = new Map(graph.clusters.map((c) => [c.id, c.parent]));
  const own = new Map<string, number>();
  const total = new Map<string, number>();
  for (const n of graph.nodes) {
    if (!n.changed) continue;
    own.set(n.cluster, (own.get(n.cluster) ?? 0) + 1);
    for (let id: string | null | undefined = n.cluster; id; id = parent.get(id)) {
      total.set(id, (total.get(id) ?? 0) + 1);
    }
  }
  /** Child clusters holding changed files, by parent (null: the top level). */
  const children = new Map<string | null, string[]>();
  for (const c of graph.clusters) {
    if (!total.get(c.id)) continue;
    children.set(c.parent, [...(children.get(c.parent) ?? []), c.id]);
  }
  const cost = (id: string) => (own.get(id) ?? 0) + (children.get(id)?.length ?? 0) - 1;
  const bySize = (a: string, b: string) => total.get(a)! - total.get(b)! || (a < b ? -1 : 1);

  const inView = [...(children.get(null) ?? [])];
  let shown = inView.length;
  const order: string[] = [];
  for (;;) {
    inView.sort(bySize);
    const i = inView.findIndex((id) => shown + cost(id) <= threshold);
    if (i < 0) return order;
    const id = inView.splice(i, 1)[0]!;
    shown += cost(id);
    order.push(id);
    inView.push(...(children.get(id) ?? []));
  }
}

export interface GraphView {
  cy: Core;
  collapseAll(): void;
  expandAll(): void;
  /** Expands the collapsed clusters around `path`, then selects and centers it. */
  reveal(path: string): void;
  /**
   * Hides file nodes failing `visible`, and clusters left with no visible file, then lays out
   * what is shown (the first call: the opening layout).
   */
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
        collapsedSize: collapsedSize(count),
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
  opts: { headless: boolean; collapseThreshold: number },
): GraphView {
  const chains = clusterChains(graph);
  const cy = cytoscape({
    ...(opts.headless ? { headless: true, styleEnabled: true } : { container }),
    elements: elements(graph, chains),
    style: stylesheet(readPalette()),
    minZoom: 0.05,
    maxZoom: 4,
  });

  /**
   * The elements on screen. `:visible` reads a per-element cache that a class change marks
   * dirty but does not clear until the style is next read, so read each style first (else a
   * filter applied just before would be ignored).
   */
  const shownElements = () => {
    cy.elements().forEach((e) => void e.style('display'));
    return cy.elements(':visible');
  };
  /** Fits the viewport to what is shown (an unfitted view opens blank). */
  const fitVisible = () => {
    const shown = shownElements();
    cy.fit(shown.nonempty() ? shown : undefined, 30);
  };
  const collapsedEnd = (e: EdgeSingular) =>
    e.source().hasClass('cy-expand-collapse-collapsed-node') ||
    e.target().hasClass('cy-expand-collapse-collapsed-node');
  let running: Layouts | null = null;
  /**
   * Lays out what is shown, then fits it (or runs `done`). `initial`: from random positions,
   * no animation (the first view and "Reset layout"). Otherwise from the current positions, so
   * an expand or collapse keeps the picture recognisable, animated in the browser.
   */
  const runLayout = (initial: boolean, done: () => void = fitVisible) => {
    running?.stop();
    const layout = shownElements().layout({
      name: 'fcose',
      animate: !initial && !opts.headless,
      animationDuration: 300,
      randomize: initial,
      fit: false,
      quality: 'default',
      nodeRepulsion: () => 6000,
      // Collapsed clusters are bigger than files; give their edges a little more room.
      idealEdgeLength: (e: EdgeSingular) => (collapsedEnd(e) ? 90 : 70),
      nodeSeparation: 60,
      // Pull the files of a cluster together: edges to other clusters otherwise stretch the
      // cluster boxes (on the CFP frontend this doubled the fitted zoom of the opening view).
      gravityCompound: 3,
      gravityRangeCompound: 0.8,
      packComponents: true,
    } as LayoutOptions);
    running = layout;
    layout.one('layoutstop', () => {
      if (running === layout) running = null;
      done();
    });
    layout.run();
  };
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

  /**
   * While clusters are collapsed, the extension reroutes the edges of their files to them
   * ("meta edges"), so parallel edges pile up between two clusters. Each set of edges between
   * the same two shown endpoints (same direction) is drawn as one `aggregate` edge labelled with
   * the count; the originals stay in the graph, hidden (`grouped`), and come back on expand.
   * Meta edges of files hidden by the filters are hidden too, so they don't count.
   */
  const clearAggregates = () => {
    cy.remove(cy.edges('.aggregate'));
    cy.edges('.grouped').removeClass('grouped');
  };
  const buildAggregates = () => {
    const groups = new Map<string, EdgeSingular[]>();
    cy.edges('.cy-expand-collapse-meta-edge').forEach((e) => {
      const ends = e.data('originalEnds') as { source: NodeSingular; target: NodeSingular };
      if (ends.source.hasClass('hidden') || ends.target.hasClass('hidden')) {
        e.addClass('grouped');
        return;
      }
      const key = `${e.source().id()}\0${e.target().id()}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    });
    const added: ElementDefinition[] = [];
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      for (const e of members) e.addClass('grouped');
      const kind = members.some((e) => e.hasClass('changed-changed'))
        ? 'changed-changed'
        : members.some((e) => e.hasClass('unchanged-changed'))
          ? 'unchanged-changed'
          : 'changed-unchanged';
      const cycle = members.some((e) => e.hasClass('cycle')) ? ' cycle' : '';
      added.push({
        group: 'edges',
        data: {
          id: `agg${added.length}`,
          source: members[0]!.source().id(),
          target: members[0]!.target().id(),
          label: `${members.length}`,
          width: aggregateWidth(members.length),
        },
        classes: `aggregate ${kind}${cycle}`,
      });
    }
    cy.add(added);
  };
  let batching = false;
  /** Runs expand/collapse steps, rebuilding the aggregate edges once around them. */
  const step = (fn: () => void) => {
    batching = true;
    clearAggregates();
    try {
      fn();
    } finally {
      batching = false;
      buildAggregates();
    }
  };
  // The extension's own cue (the +/− on a cluster) expands and collapses outside `step`; one
  // click may fire several events, so the layout after it runs once.
  let cueLayout = false;
  cy.on('expandcollapse.beforecollapse expandcollapse.beforeexpand', () => {
    if (!batching) clearAggregates();
  });
  cy.on('expandcollapse.aftercollapse expandcollapse.afterexpand', () => {
    if (batching) return;
    buildAggregates();
    if (cueLayout) return;
    cueLayout = true;
    setTimeout(() => {
      cueLayout = false;
      runLayout(false);
    }, 0);
  });

  if (graph.nodes.filter((n) => n.changed).length > opts.collapseThreshold) {
    step(() => {
      ec.collapseAll();
      for (const id of clustersToExpand(graph, opts.collapseThreshold)) ec.expand(byId.get(id)!);
    });
  }
  // No layout yet: the first `setVisible` (the filters' opening state, which hides the
  // unchanged neighbors) lays out what is shown then, so hidden files leave no holes.
  let laidOut = false;
  if (!opts.headless) {
    // The container may get its final size only after first layout of the page.
    requestAnimationFrame(() => {
      cy.resize();
      fitVisible();
    });
  }

  cy.on('dbltap', 'node.cluster', (e) => {
    const n = e.target as NodeSingular;
    step(() => {
      if (ec.isExpandable(n)) ec.expand(n);
      else if (ec.isCollapsible(n)) ec.collapse(n);
    });
    runLayout(false);
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
      step(() => ec.collapseAll());
      runLayout(false);
    },
    expandAll() {
      step(() => ec.expandAll());
      runLayout(false);
    },

    reveal(path) {
      const node = nodeByPath.get(path);
      if (!node) return;
      const el = byId.get(fileId(path))!;
      const center = () => {
        if (!el.inside()) return;
        if (opts.headless) cy.center(el);
        else cy.animate({ center: { eles: el }, duration: 250 });
      };
      if (collapsedHolder(node)) {
        step(() => {
          for (let holder = collapsedHolder(node); holder; holder = collapsedHolder(node)) {
            ec.expand(holder);
          }
        });
        runLayout(false, center);
      } else {
        center();
      }
      if (!el.inside()) return;
      cy.elements(':selected').unselect();
      el.select();
    },

    setVisible(visible) {
      const shown = new Set<string>();
      graph.nodes.forEach((n, i) => {
        const on = visible(n);
        fileEls[i]!.toggleClass('hidden', !on);
        if (on) for (const id of chains.get(n.cluster) ?? []) shown.add(id);
      });
      for (const el of clusterEls) el.toggleClass('hidden', !shown.has(el.id()));
      // Hidden files leave the aggregate counts.
      step(() => undefined);
      runLayout(!laidOut);
      laidOut = true;
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
      runLayout(true);
    },

    onOpen(cb) {
      cy.on('tap', 'node.file', (e) => cb((e.target as NodeSingular).data('path') as string));
    },
  };
}
