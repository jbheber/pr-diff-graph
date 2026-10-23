import { describe, expect, it } from 'vitest';
import { buildCommentBody, MARKER, upsertStickyComment } from '../../../src/publish/comment.js';
import type { CommentSummary } from '../../../src/publish/summary.js';
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
