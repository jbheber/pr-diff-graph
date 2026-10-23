import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiffEntry, GraphJson } from '../graph/types.js';

export interface ReportAssets {
  template: string;
  clientJs: string;
  clientCss: string;
}

export interface ReportOptions {
  collapseThreshold: number;
}

export const TEMPLATE_FILE = 'template.html';
export const CLIENT_JS_FILE = 'report-client.js';
export const CLIENT_CSS_FILE = 'report-client.css';

/**
 * Where the report assets live: `dist/`, next to the action bundle or one level above the CLI
 * bundle (`dist/cli/`), or `build/client/` (made by `npm run build:client`) when running from
 * source.
 */
export function reportAssetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [here, join(here, '..'), join(here, '..', '..', 'build', 'client')];
  return candidates.find((d) => existsSync(join(d, CLIENT_JS_FILE))) ?? candidates[2]!;
}

export async function loadReportAssets(dir: string): Promise<ReportAssets> {
  const read = async (name: string) => {
    try {
      return await readFile(join(dir, name), 'utf8');
    } catch (e) {
      throw new Error(
        `report asset ${name} not found in ${dir} (run \`npm run build:client\`): ${(e as Error).message}`,
        { cause: e },
      );
    }
  };
  const [template, clientJs, clientCss] = await Promise.all([
    read(TEMPLATE_FILE),
    read(CLIENT_JS_FILE),
    read(CLIENT_CSS_FILE),
  ]);
  return { template, clientJs, clientCss };
}

/**
 * JSON safe to place inside `<script type="application/json">`: nothing in it can close the
 * element or open a comment, and U+2028/2029 can't break a JS string if it is ever evaluated.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `</script` / `</style` inside inlined code would end the element early. */
function escapeClosingTag(code: string, tag: 'script' | 'style'): string {
  return code.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');
}

function title(graph: GraphJson): string {
  const parts = [graph.pr.number !== null ? `PR #${graph.pr.number}` : null, graph.pr.repo];
  const what = parts.filter((p) => p !== null).join(' · ');
  return what ? `${what} — pr-diff-graph` : 'pr-diff-graph report';
}

/** Fills the template's placeholders in one pass, so data can't inject another placeholder. */
export function renderReport(
  graph: GraphJson,
  diffs: DiffEntry[],
  opts: ReportOptions,
  assets: ReportAssets,
): string {
  const values: Record<string, string> = {
    TITLE: escapeHtml(title(graph)),
    STYLE: escapeClosingTag(assets.clientCss, 'style'),
    SCRIPT: escapeClosingTag(assets.clientJs, 'script'),
    GRAPH_JSON: embedJson(graph),
    DIFFS_JSON: embedJson(diffs),
    OPTIONS_JSON: embedJson({ collapseThreshold: opts.collapseThreshold }),
  };
  return assets.template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name]! : whole,
  );
}
