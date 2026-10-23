import { describe, expect, it } from 'vitest';
import { buildCommentBody, MARKER, upsertStickyComment } from '../../../src/publish/comment.js';
import type { GraphEdge, GraphJson, GraphNode } from '../../../src/graph/types.js';
import type { PipelineResult } from '../../../src/pipeline.js';
import {
  parseSummaryJson,
  toCommentSummary,
  type CommentSummary,
} from '../../../src/publish/summary.js';
import { fakeOctokit, httpError, type FakeComment } from '../../helpers/fakeoctokit.js';

const summary: CommentSummary = {
  version: 1,
  skipped: false,
  minFiles: 50,
  files: 120,
  additions: 3000,
  deletions: 200,
  edges: 340,
  cycles: 2,
  unresolved: 4,
  parseErrors: 1,
  top: ['src/a.ts', 'src/`x`<img src=y>.ts'],
  headSha: 'a'.repeat(40),
};
const links = {
  artifactUrl: 'https://github.com/o/r/actions/runs/9/artifacts/5',
  runUrl: 'https://github.com/o/r/actions/runs/9',
};

describe('buildCommentBody', () => {
  it('body starts with the marker', () => {
    const body = buildCommentBody(summary, links);
    expect(MARKER).toBe('<!-- pr-diff-graph:v1 -->');
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain('120');
    expect(body).toContain(links.artifactUrl);
    expect(body).toContain(links.runUrl);
  });

  it('replaces backticks and keeps markup literal inside the code span', () => {
    const body = buildCommentBody(summary, links);
    expect(body).toContain('`src/a.ts`');
    expect(body).toContain('`src/ˋxˋ<img src=y>.ts`');
    expect(body).not.toContain('&lt;');
  });

  it('keeps a path with CR/LF on its list line', () => {
    const body = buildCommentBody({ ...summary, top: ['a\r\n# heading.ts'] }, links);
    expect(body).not.toContain('\n# heading');
    expect(body).toContain('`a  # heading.ts`');
  });

  it('removes bidi controls', () => {
    const rlo = String.fromCharCode(0x202e);
    const isolate = String.fromCharCode(0x2066);
    const body = buildCommentBody({ ...summary, top: [`a${rlo}b${isolate}c.ts`] }, links);
    expect(body).toContain('`abc.ts`');
  });

  it('links the run when there is no artifact', () => {
    const body = buildCommentBody(summary, { artifactUrl: null, runUrl: links.runUrl });
    expect(body).toContain(links.runUrl);
    expect(body).not.toContain('/artifacts/');
  });

  it('skipped body', () => {
    const body = buildCommentBody({ ...summary, skipped: true, files: 12, top: [] }, links);
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toMatch(/12 changed files/);
    expect(body).toMatch(/at or under.*50/);
    expect(body).not.toContain('/artifacts/');
  });
});

describe('buildCommentBody: plurals', () => {
  const ones = {
    ...summary,
    files: 1,
    edges: 1,
    cycles: 1,
    unresolved: 1,
    parseErrors: 1,
  };

  it('uses the singular for 1', () => {
    const body = buildCommentBody(ones, links);
    expect(body).toContain('**1** changed file (');
    expect(body).toContain('**1** import edge ·');
    expect(body).toContain('**1** cycle ·');
    expect(body).toContain('**1** unresolved import ·');
    expect(body).toMatch(/\*\*1\*\* parse error$/m);
    const skipped = buildCommentBody({ ...ones, skipped: true, minFiles: 1 }, links);
    expect(skipped).toContain('This PR has 1 changed file,');
  });

  it('uses the plural for 0 and 2', () => {
    for (const k of [0, 2]) {
      const body = buildCommentBody(
        { ...summary, files: k, edges: k, cycles: k, unresolved: k, parseErrors: k },
        links,
      );
      expect(body).toContain(`**${k}** changed files (`);
      expect(body).toContain(`**${k}** import edges ·`);
      expect(body).toContain(`**${k}** cycles ·`);
      expect(body).toContain(`**${k}** unresolved imports ·`);
      expect(body).toContain(`**${k}** parse errors`);
      const skipped = buildCommentBody({ ...summary, files: k, skipped: true }, links);
      expect(skipped).toContain(`This PR has ${k} changed files,`);
    }
  });
});

describe('buildCommentBody: graphs', () => {
  const graphs: CommentSummary['graphs'] = {
    boxes: [
      { label: 'src/a', files: 2, kind: 'dir' },
      { label: 'src/b', files: 1, kind: 'dir' },
    ],
    arrows: [{ from: 0, to: 1, count: 3, cycle: false }],
    nodes: [
      { path: 'src/a/x.ts', status: 'added' },
      { path: 'src/b/y.ts', status: 'modified' },
    ],
    edges: [{ from: 0, to: 1, cycle: true }],
  };

  it('appends the graph sections after the top files, before the links', () => {
    const body = buildCommentBody({ ...summary, graphs }, links);
    const top = body.indexOf('**Most connected changed files**');
    const mermaid = body.indexOf('```mermaid');
    const link = body.indexOf('[Download the interactive report]');
    expect(top).toBeGreaterThan(0);
    expect(mermaid).toBeGreaterThan(top);
    expect(link).toBeGreaterThan(mermaid);
    expect(buildCommentBody(summary, links)).not.toContain('```mermaid');
  });

  it('draws no graphs on a skipped body', () => {
    const body = buildCommentBody({ ...summary, skipped: true, graphs }, links);
    expect(body).not.toContain('```mermaid');
  });

  it('keeps hostile summary.json labels and paths inert, end to end', () => {
    const evil = [
      '```\n```html',
      '%%{init: {"theme":"dark"}}%%',
      '<img src=x onerror=alert(1)>',
      'a"]-->X["b',
      'line\nbreak',
    ];
    const raw = JSON.stringify({
      ...summary,
      top: ['src/a.ts'],
      graphs: {
        boxes: [
          ...evil.map((label) => ({ label, files: 1, kind: 'dir' })),
          { label: evil[2], files: 1, kind: 'own' },
        ],
        arrows: evil.map((_, i) => ({ from: i, to: i + 1, count: 1, cycle: i === 0 })),
        nodes: evil.map((path) => ({ path, status: 'added' })),
        edges: evil.slice(1).map((_, i) => ({ from: i, to: i + 1, cycle: false })),
      },
    });
    const body = buildCommentBody(parseSummaryJson(raw), links);
    expect(body.split('\n').filter((l) => l.startsWith('```'))).toHaveLength(4);
    expect(body).not.toContain('%%');
    expect(body).not.toContain('<img');
    expect(body).not.toContain('onerror=');
    // every Mermaid label opens and closes on its own line
    for (const line of body.split('\n')) {
      expect(line.split('["').length).toBe(line.split('"]').length);
    }
    expect(body).toContain('b0["_______html · 1 file"]');
    expect(body).toContain('f4["line_break"]');
  });

  it('keeps a 500-file PR comment under 20,000 characters', () => {
    // 500 changed files in 5 packages × 10 directories, plus 200 neighbors, ~4 imports each
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const clusters = [];
    const nodes: GraphNode[] = [];
    for (let p = 0; p < 5; p++) {
      clusters.push({ id: `c:packages/pkg-${p}`, label: `packages/pkg-${p}`, parent: null });
      for (let d = 0; d < 10; d++) {
        const dir = `packages/pkg-${p}/src/feature-with-a-long-name-${d}`;
        clusters.push({ id: `c:${dir}`, label: dir, parent: `c:packages/pkg-${p}` });
        for (let f = 0; f < 14; f++) {
          const changed = f < 10;
          const path = `${dir}/some-component-file-${f}.tsx`;
          nodes.push({
            id: path,
            path,
            cluster: `c:${dir}`,
            changed,
            status: changed
              ? (['added', 'modified', 'deleted', 'renamed'] as const)[f % 4]
              : 'unchanged',
          } as GraphNode);
        }
      }
    }
    const edges: GraphEdge[] = [];
    for (const n of nodes) {
      if (!n.changed) continue;
      for (let k = 0; k < 4; k++) {
        const to = nodes[Math.floor(rand() * nodes.length)]!;
        if (to.id === n.id) continue;
        edges.push({
          from: n.id,
          to: to.id,
          kind: to.changed ? 'changed-changed' : 'changed-unchanged',
          importKinds: ['static'],
          inCycle: rand() < 0.1,
        });
      }
    }
    const changed = nodes.filter((n) => n.changed);
    expect(changed).toHaveLength(500);
    const graph = {
      summary: { files: 500, additions: 9000, deletions: 900, edges: edges.length, cycles: 3 },
      clusters,
      nodes,
      edges,
      cycles: [changed.slice(0, 8).map((n) => n.id), changed.slice(100, 120).map((n) => n.id)],
      ranking: changed.slice(0, 10).map((n) => n.id),
    } as unknown as GraphJson;
    const result: PipelineResult = {
      skipped: false,
      filesChanged: 500,
      rawFilesChanged: 500,
      graph,
      reportPath: null,
      graphPath: null,
      summaryPath: null,
    };
    const s = toCommentSummary(result, 50, 'a'.repeat(40));
    // no package holds more than 25% of the files, and splitting one would make 14 boxes
    expect(s.graphs!.boxes).toHaveLength(5);
    expect(s.graphs!.arrows.length).toBeGreaterThan(10);
    expect(s.graphs!.nodes).toHaveLength(25);
    const body = buildCommentBody(s, links);
    expect(body).toContain('```mermaid');
    expect(body.length).toBeLessThan(20_000);
  });

  it('keeps a comment with every list at its cap and 300-character paths under 20,000', () => {
    const path = (i: number) => 'x'.repeat(290) + `/${i}.ts`;
    const full: CommentSummary['graphs'] = {
      boxes: Array.from({ length: 12 }, (_, i) => ({
        label: path(i),
        files: 9_999_999,
        kind: 'own' as const,
      })),
      arrows: Array.from({ length: 30 }, (_, i) => ({
        from: i % 12,
        to: (i + 1) % 12,
        count: 9_999_999,
        cycle: true,
      })),
      nodes: Array.from({ length: 25 }, (_, i) => ({ path: path(i), status: 'renamed' as const })),
      edges: Array.from({ length: 60 }, (_, i) => ({
        from: i % 25,
        to: (i + 3) % 25,
        cycle: true,
      })),
    };
    const top = Array.from({ length: 5 }, (_, i) => path(i));
    const body = buildCommentBody({ ...summary, top, graphs: full }, links);
    expect(body.length).toBeLessThan(20_000);
  });
});

const bot = { login: 'github-actions[bot]', type: 'Bot' };
const human = { login: 'alice', type: 'User' };
const p = { owner: 'o', repo: 'r', issueNumber: 7, body: 'new body' };

function filler(n: number, start = 1): FakeComment[] {
  return Array.from({ length: n }, (_, i) => ({ id: start + i, body: 'hi', user: human }));
}

describe('upsertStickyComment', () => {
  it('upsert updates the existing marker comment', async () => {
    const comments = [...filler(100), { id: 500, body: `${MARKER}\nold`, user: bot }];
    const octokit = fakeOctokit({ comments });
    expect(await upsertStickyComment(octokit, p)).toBe('updated');
    expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(2);
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      comment_id: 500,
      body: 'new body',
    });
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('upsert creates when none', async () => {
    const octokit = fakeOctokit({ comments: filler(3) });
    expect(await upsertStickyComment(octokit, p)).toBe('created');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: 7,
      body: 'new body',
    });
  });

  it("ignores a human's quoted copy of the marker", async () => {
    const octokit = fakeOctokit({ comments: [{ id: 3, body: `> ${MARKER}`, user: human }] });
    expect(await upsertStickyComment(octokit, p)).toBe('created');
  });

  it('matches the token owner when GET /user succeeds', async () => {
    const comments = [
      { id: 3, body: MARKER, user: bot },
      { id: 4, body: MARKER, user: { login: 'pat-owner', type: 'User' } },
    ];
    const octokit = fakeOctokit({ comments, login: 'pat-owner' });
    expect(await upsertStickyComment(octokit, p)).toBe('updated');
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 4 }),
    );
  });

  it('with GITHUB_TOKEN (GET /user 403) matches only github-actions[bot], not any bot', async () => {
    const comments = [
      { id: 3, body: MARKER, user: { login: 'other-app[bot]', type: 'Bot' } },
      { id: 4, body: MARKER, user: bot },
    ];
    const octokit = fakeOctokit({ comments });
    expect(await upsertStickyComment(octokit, p)).toBe('updated');
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 4 }),
    );

    const onlyOther = fakeOctokit({ comments: [comments[0]!] });
    expect(await upsertStickyComment(onlyOther, p)).toBe('created');
  });

  it('rethrows a GET /user failure other than 403', async () => {
    const octokit = fakeOctokit({
      comments: [{ id: 4, body: MARKER, user: bot }],
      userError: httpError(500, 'server error'),
    });
    await expect(upsertStickyComment(octokit, p)).rejects.toThrow('server error');
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('updateOnly: does not create', async () => {
    const octokit = fakeOctokit({ comments: filler(2) });
    expect(await upsertStickyComment(octokit, { ...p, updateOnly: true })).toBe('none');
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });
});
