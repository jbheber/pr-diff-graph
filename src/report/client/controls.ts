import type { GraphJson, GraphNode } from '../../graph/types.js';
import { byId, el } from './dom.js';
import type { GraphView } from './graph.js';

const TOP = 10;

function link(path: string, onOpen: (path: string) => void): HTMLButtonElement {
  const b = el('button', { className: 'pdg-link', type: 'button' }, path);
  b.addEventListener('click', () => onOpen(path));
  return b;
}

/** Header: title, totals, top-10 ranking, cycles and unresolved imports. */
export function renderSummary(graph: GraphJson, onOpen: (path: string) => void): void {
  const { pr, summary: s } = graph;
  byId('title').textContent = [
    pr.number !== null ? `PR #${pr.number}` : 'Diff',
    pr.repo,
    `${pr.mergeBase.slice(0, 7)}…${pr.head.slice(0, 7)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const totals: [string, string, string][] = [
    ['files', `${s.files}`, 'files'],
    ['lines', `+${s.additions} −${s.deletions}`, 'lines'],
    ['edges', `${s.edges}`, 'imports between files'],
    ['cycles', `${s.cycles}`, s.cycles === 1 ? 'cycle' : 'cycles'],
    ['unresolved', `${s.unresolved}`, 'unresolved imports'],
    ['parse-errors', `${s.parseErrors}`, s.parseErrors === 1 ? 'parse error' : 'parse errors'],
  ];
  byId('totals').replaceChildren(
    ...totals.map(([key, value, label]) => {
      const li = el('li', {}, el('strong', {}, value), ` ${label}`);
      li.dataset['total'] = key;
      return li;
    }),
  );

  byId('top-list').replaceChildren(
    ...graph.ranking.slice(0, TOP).map((p) => el('li', {}, link(p, onOpen))),
  );
  byId('cycles').hidden = graph.cycles.length === 0;
  byId('cycle-list').replaceChildren(
    ...graph.cycles.map((members) =>
      el(
        'li',
        {},
        ...members.flatMap((p, i) => (i ? [' → ', link(p, onOpen)] : [link(p, onOpen)])),
      ),
    ),
  );
  byId('unresolved').hidden = graph.unresolved.length === 0;
  byId('unresolved-list').replaceChildren(
    ...graph.unresolved.map((u) =>
      el(
        'li',
        {},
        link(u.from, onOpen),
        `:${u.line} `,
        el('code', {}, u.specifier),
        el('span', { className: 'pdg-muted' }, ` (${u.reason})`),
      ),
    ),
  );
}

/** Search, status / directory / neighbor filters, collapse and layout buttons. */
export function wireControls(graph: GraphJson, view: GraphView): void {
  const search = byId<HTMLInputElement>('search');
  const count = byId('search-count');
  const statusBoxes = [
    ...byId('status-filter').querySelectorAll<HTMLInputElement>('input[name=status]'),
  ];
  const clusterSelect = byId<HTMLSelectElement>('cluster-filter');
  const neighbors = byId<HTMLInputElement>('neighbors');

  const chainOf = new Map<string, string[]>();
  const parent = new Map(graph.clusters.map((c) => [c.id, c.parent]));
  for (const c of graph.clusters) {
    const chain: string[] = [];
    for (let id: string | null | undefined = c.id; id; id = parent.get(id)) chain.push(id);
    chainOf.set(c.id, chain);
  }
  // Nested cluster labels are relative to their parent; the filter lists full paths.
  const fullPath = (id: string) => id.slice(2);
  for (const c of [...graph.clusters].sort((a, b) =>
    fullPath(a.id).localeCompare(fullPath(b.id)),
  )) {
    const option = el('option', {}, fullPath(c.id));
    option.value = c.id;
    clusterSelect.append(option);
  }

  function visible(n: GraphNode): boolean {
    const statuses = new Set(statusBoxes.filter((b) => b.checked).map((b) => b.value));
    if (n.changed ? !statuses.has(n.status) : !neighbors.checked) return false;
    const cluster = clusterSelect.value;
    return !cluster || (chainOf.get(n.cluster) ?? []).includes(cluster);
  }

  function applySearch() {
    const q = search.value.trim().toLowerCase();
    if (!q) {
      view.highlight(new Set());
      count.textContent = '';
      return;
    }
    const hits = graph.nodes.filter(
      (n) =>
        visible(n) &&
        (n.path.toLowerCase().includes(q) || (n.oldPath ?? '').toLowerCase().includes(q)),
    );
    view.highlight(new Set(hits.map((n) => n.id)));
    count.textContent = `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`;
  }

  function applyFilters() {
    view.setVisible(visible);
    applySearch();
  }

  search.addEventListener('input', applySearch);
  for (const b of [...statusBoxes, neighbors]) b.addEventListener('change', applyFilters);
  clusterSelect.addEventListener('change', applyFilters);
  byId('collapse-all').addEventListener('click', () => view.collapseAll());
  byId('expand-all').addEventListener('click', () => view.expandAll());
  byId('reset-layout').addEventListener('click', () => view.resetLayout());
  applyFilters();
}
