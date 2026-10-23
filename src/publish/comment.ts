import { renderGraphSections } from './graphs.js';
import type { CommentSummary } from './summary.js';

/** Hidden marker identifying the action's sticky comment. */
export const MARKER = '<!-- pr-diff-graph:v1 -->';

export interface Links {
  artifactUrl: string | null;
  runUrl: string;
}

interface IssueComment {
  id: number;
  body?: string;
  user: { login: string; type: string } | null;
}

/** The octokit methods the sticky comment needs (a real `getOctokit` client satisfies it). */
export interface CommentOctokit {
  rest: {
    users: { getAuthenticated(): Promise<{ data: { login: string } }> };
    issues: {
      listComments(p: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: IssueComment[] }>;
      createComment(p: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
      updateComment(p: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
    };
  };
}

/** The account `GITHUB_TOKEN` comments as. */
export const ACTIONS_BOT = 'github-actions[bot]';

/**
 * A repo path as a markdown code span. Markdown inside a code span is inert, so only what could
 * break out of it or the list line is changed: backticks become `ˋ`, control characters (CR, LF,
 * tab...) a space, and bidi controls, which could make the path read as something else, are
 * removed.
 */
export function codePath(path: string): string {
  const safe = path
    .replaceAll('`', 'ˋ')
    // eslint-disable-next-line no-control-regex -- control characters are what it replaces
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
  return `\`${safe}\``;
}

const n = (x: number) => x.toLocaleString('en-US');

/** `one` for exactly 1, else `many` (0 files, 1 file, 2 files). */
export function plural(x: number, one: string, many = `${one}s`): string {
  return x === 1 ? one : many;
}

/** A bold count and its noun: `**1** cycle`, `**2** cycles`. */
const total = (x: number, one: string) => `**${n(x)}** ${plural(x, one)}`;

/** The comment and job-summary markdown, without the marker. */
export function buildSummaryMarkdown(s: CommentSummary, links: Links): string {
  const lines = ['### PR diff graph', ''];
  if (s.skipped) {
    lines.push(
      `This PR has ${n(s.files)} changed ${plural(s.files, 'file')}, at or under the \`min-files\` threshold ` +
        `(${n(s.minFiles)}), so no report was built.`,
      '',
      `[Workflow run](${links.runUrl})`,
    );
    return lines.join('\n') + '\n';
  }
  lines.push(
    `${total(s.files, 'changed file')} (+${n(s.additions)} / −${n(s.deletions)}) · ` +
      `${total(s.edges, 'import edge')} · ${total(s.cycles, 'cycle')} · ` +
      `${total(s.unresolved, 'unresolved import')} · ${total(s.parseErrors, 'parse error')}`,
  );
  if (s.top.length > 0) {
    lines.push('', '**Most connected changed files**', '');
    s.top.forEach((p, i) => lines.push(`${i + 1}. ${codePath(p)}`));
  }
  // Generated from the schema-checked structure, never from text in summary.json.
  const graphs = s.graphs ? renderGraphSections(s.graphs) : '';
  if (graphs) lines.push('', graphs);
  lines.push('');
  lines.push(
    links.artifactUrl
      ? `[Download the interactive report](${links.artifactUrl}) (unzip, open \`report.html\`) · ` +
          `[Workflow run](${links.runUrl})`
      : `The report is in the artifacts of the [workflow run](${links.runUrl}).`,
  );
  return lines.join('\n') + '\n';
}

export function buildCommentBody(s: CommentSummary, links: Links): string {
  return `${MARKER}\n${buildSummaryMarkdown(s, links)}`;
}

const PAGE = 100;

/**
 * Who wrote our comment: the token's own user when `GET /user` works (a PAT or app user token);
 * with `GITHUB_TOKEN` it answers 403, and then only `github-actions[bot]` is accepted. Any other
 * error is rethrown. A human's comment quoting the marker is never matched.
 */
async function isOurs(octokit: CommentOctokit): Promise<(c: IssueComment) => boolean> {
  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    return (c) => c.user?.login === data.login;
  } catch (e) {
    if ((e as { status?: unknown } | null)?.status !== 403) throw e;
    return (c) => c.user?.login === ACTIONS_BOT;
  }
}

/**
 * Updates the sticky comment on the PR, or creates it. With `updateOnly` a missing comment is
 * left missing (`'none'`).
 */
export async function upsertStickyComment(
  octokit: CommentOctokit,
  p: { owner: string; repo: string; issueNumber: number; body: string; updateOnly?: boolean },
): Promise<'created' | 'updated' | 'none'> {
  const ours = await isOurs(octokit);
  let existing: IssueComment | undefined;
  for (let page = 1; !existing; page++) {
    const { data } = await octokit.rest.issues.listComments({
      owner: p.owner,
      repo: p.repo,
      issue_number: p.issueNumber,
      per_page: PAGE,
      page,
    });
    existing = data.find((c) => (c.body ?? '').startsWith(MARKER) && ours(c));
    if (data.length < PAGE) break;
  }
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: p.owner,
      repo: p.repo,
      comment_id: existing.id,
      body: p.body,
    });
    return 'updated';
  }
  if (p.updateOnly) return 'none';
  await octokit.rest.issues.createComment({
    owner: p.owner,
    repo: p.repo,
    issue_number: p.issueNumber,
    body: p.body,
  });
  return 'created';
}
