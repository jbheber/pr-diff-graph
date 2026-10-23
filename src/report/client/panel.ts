import type { DiffEntry, GraphEdge, GraphJson, GraphNode } from '../../graph/types.js';
import type { RenderDiff } from './diff.js';
import { byId, el } from './dom.js';

export interface Panel {
  show(node: GraphNode): void;
  hide(): void;
}

/** Repo-derived text goes in through `textContent` only (see `el`). */
export function createPanel(opts: {
  graph: GraphJson;
  diffs: DiffEntry[];
  renderDiff: RenderDiff;
  onOpen: (path: string) => void;
}): Panel {
  const { graph, diffs } = opts;
  const root = byId('panel');
  const incoming = new Map<string, GraphEdge[]>();
  const outgoing = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
  }
  /** Rendered diffs by diffRef: each is rendered the first time its node is opened. */
  const rendered = new Map<number, HTMLElement>();

  byId('panel-close').addEventListener('click', () => (root.hidden = true));

  function edgeList(listId: string, countId: string, edges: GraphEdge[], end: 'from' | 'to') {
    byId(countId).textContent = String(edges.length);
    byId(listId).replaceChildren(
      ...edges.map((e) => {
        const link = el('button', { className: 'pdg-link', type: 'button' }, e[end]);
        link.addEventListener('click', () => opts.onOpen(e[end]));
        const kinds = e.importKinds.filter((k) => k !== 'static');
        const extra = [e.inCycle ? 'cycle' : '', ...kinds].filter(Boolean).join(', ');
        return el('li', {}, link, extra ? el('span', { className: 'pdg-muted' }, ` ${extra}`) : '');
      }),
    );
  }

  function meta(node: GraphNode) {
    const rows: [string, string][] = [
      ['Status', node.status],
      ['Lines', `+${node.additions} −${node.deletions}`],
      ['Language', node.language ?? '—'],
      // Labels of nested clusters are relative to their parent; this names the full path.
      ['Cluster', node.cluster.slice(2)],
    ];
    if (node.binary) rows.push(['Binary', 'yes']);
    if (node.parseError) rows.push(['Parse error', node.parseError]);
    byId('panel-meta').replaceChildren(
      ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]),
    );
  }

  function diffFor(node: GraphNode): HTMLElement {
    if (node.diffRef === null) {
      return el('p', { className: 'pdg-muted' }, 'Not changed in this PR (an imported neighbor).');
    }
    const cached = rendered.get(node.diffRef);
    if (cached) return cached;
    const entry = diffs[node.diffRef];
    const box = el('div', { className: 'pdg-diff-body' });
    if (!entry || entry.binary) {
      box.append(el('p', { className: 'pdg-muted' }, 'Binary file: no text diff.'));
    } else if (!entry.patch) {
      box.append(el('p', { className: 'pdg-muted' }, 'No text changes.'));
    } else {
      if (entry.truncated) {
        box.append(el('p', { className: 'pdg-note' }, 'Patch truncated (max-patch-bytes).'));
      }
      const target = el('div');
      try {
        opts.renderDiff(target, entry.patch);
      } catch (e) {
        // Never lose the diff to a renderer failure: show the raw patch as text instead.
        target.replaceChildren(
          el(
            'p',
            { className: 'pdg-note' },
            `Diff view failed (${(e as Error).message}); raw patch:`,
          ),
          el('pre', { className: 'pdg-raw' }, entry.patch),
        );
      }
      box.append(target);
    }
    rendered.set(node.diffRef, box);
    return box;
  }

  return {
    show(node) {
      byId('panel-path').textContent = node.path;
      byId('panel-old-path').textContent = node.oldPath ? `was ${node.oldPath}` : '';
      meta(node);
      edgeList('panel-in', 'panel-in-count', incoming.get(node.id) ?? [], 'from');
      edgeList('panel-out', 'panel-out-count', outgoing.get(node.id) ?? [], 'to');
      root.hidden = false;
      const slot = byId('panel-diff');
      slot.replaceChildren(); // never leave the previous file's diff under this file's name
      slot.replaceChildren(diffFor(node));
    },
    hide() {
      root.hidden = true;
    },
  };
}
