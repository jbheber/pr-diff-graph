import type { StylesheetJson } from 'cytoscape';

export interface Palette {
  bg: string;
  fg: string;
  muted: string;
  added: string;
  modified: string;
  deleted: string;
  renamed: string;
  unchanged: string;
  cluster: string;
  edge: string;
  edgeStrong: string;
  cycle: string;
  match: string;
  selected: string;
}

/** Fallbacks (the light palette) for when the CSS custom properties can't be read. */
const DEFAULTS: Palette = {
  bg: '#ffffff',
  fg: '#1f2328',
  muted: '#656d76',
  added: '#009e73',
  modified: '#0072b2',
  deleted: '#d55e00',
  renamed: '#cc79a7',
  unchanged: '#8c959f',
  cluster: '#8c959f',
  edge: '#8c959f',
  edgeStrong: '#57606a',
  cycle: '#d62728',
  match: '#f0b400',
  selected: '#1f2328',
};

const VARS: Record<keyof Palette, string> = {
  bg: '--pdg-bg',
  fg: '--pdg-fg',
  muted: '--pdg-muted',
  added: '--pdg-added',
  modified: '--pdg-modified',
  deleted: '--pdg-deleted',
  renamed: '--pdg-renamed',
  unchanged: '--pdg-unchanged',
  cluster: '--pdg-cluster',
  edge: '--pdg-edge',
  edgeStrong: '--pdg-edge-strong',
  cycle: '--pdg-cycle',
  match: '--pdg-match',
  selected: '--pdg-selected',
};

/** The status colors and friends from the page's CSS (which follows the OS light/dark setting). */
export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const out = { ...DEFAULTS };
  for (const key of Object.keys(VARS) as (keyof Palette)[]) {
    const v = css.getPropertyValue(VARS[key]).trim();
    if (v) out[key] = v;
  }
  return out;
}

/** Node diameter: log-scaled lines changed, clamped to [18, 72]. */
export function nodeSize(additions: number, deletions: number): number {
  return Math.min(72, Math.max(18, 18 + 8 * Math.log2(1 + additions + deletions)));
}

/** Color is status; so is the border style, so color is never the only channel. */
export function stylesheet(p: Palette): StylesheetJson {
  return [
    {
      selector: 'node.file',
      style: {
        width: 'data(size)',
        height: 'data(size)',
        // The basename below the node, outlined in the page background so it reads over edges.
        label: 'data(label)',
        'font-size': 12,
        color: p.fg,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-max-width': '140px',
        'text-wrap': 'ellipsis',
        'text-outline-color': p.bg,
        'text-outline-width': 2,
        // 12px × zoom < 6px: labels drop out below zoom 0.5, keeping big graphs legible.
        'min-zoomed-font-size': 6,
        'border-color': p.fg,
        'border-opacity': 0.8,
      },
    },
    {
      selector: 'node.status-added',
      style: { 'background-color': p.added, 'border-width': 4, 'border-style': 'solid' },
    },
    {
      selector: 'node.status-modified',
      style: { 'background-color': p.modified, 'border-width': 1.5, 'border-style': 'solid' },
    },
    {
      selector: 'node.status-deleted',
      style: { 'background-color': p.deleted, 'border-width': 3, 'border-style': 'dashed' },
    },
    {
      selector: 'node.status-renamed',
      style: { 'background-color': p.renamed, 'border-width': 5, 'border-style': 'double' },
    },
    {
      selector: 'node.status-unchanged',
      style: {
        'background-color': p.unchanged,
        'border-width': 1.5,
        'border-style': 'dotted',
        opacity: 0.75,
      },
    },
    {
      selector: 'node.cluster',
      style: {
        shape: 'round-rectangle',
        label: 'data(label)',
        'font-size': 13,
        color: p.muted,
        'text-outline-color': p.bg,
        'text-outline-width': 2,
        'min-zoomed-font-size': 4,
        'text-valign': 'top',
        'text-halign': 'center',
        'background-color': p.cluster,
        'background-opacity': 0.07,
        'border-width': 1,
        'border-color': p.cluster,
        'border-opacity': 0.5,
        padding: '14px',
      },
    },
    {
      selector: 'node.cy-expand-collapse-collapsed-node',
      style: {
        label: 'data(countLabel)',
        width: 46,
        height: 30,
        color: p.fg,
        'text-margin-y': 4,
        'background-opacity': 0.25,
        'border-width': 2,
        'border-style': 'double',
        'text-valign': 'bottom',
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1,
        'line-color': p.edge,
        'target-arrow-color': p.edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        'curve-style': 'bezier',
        opacity: 0.55,
      },
    },
    {
      selector: 'edge.changed-changed',
      style: {
        width: 1.6,
        'line-color': p.edgeStrong,
        'target-arrow-color': p.edgeStrong,
        opacity: 0.9,
      },
    },
    {
      selector: 'edge.cycle',
      style: { width: 3.5, 'line-color': p.cycle, 'target-arrow-color': p.cycle, opacity: 1 },
    },
    {
      selector: '.match',
      style: { 'underlay-color': p.match, 'underlay-opacity': 0.55, 'underlay-padding': 7 },
    },
    {
      selector: 'node:selected',
      style: { 'overlay-color': p.selected, 'overlay-opacity': 0.18, 'overlay-padding': 6 },
    },
    { selector: '.hidden', style: { display: 'none' } },
  ];
}
