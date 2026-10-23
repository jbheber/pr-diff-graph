import * as core from '@actions/core';
import * as github from '@actions/github';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEntryPoint } from './entry.js';
import { parseInputs, type ActionInputs } from './inputs.js';
import { actionsLogger } from './log.js';
import { grammarDir } from './parsers/treesitter.js';
import { runPipeline } from './pipeline.js';
import {
  downloadSummary,
  summaryArtifactName,
  uploadReport,
  type ArtifactOctokit,
} from './publish/artifact.js';
import {
  buildCommentBody,
  upsertStickyComment,
  type CommentOctokit,
  type Links,
} from './publish/comment.js';
import { writeJobSummary, type SummaryWriter } from './publish/jobsummary.js';
import {
  parseSummaryJson,
  toCommentSummary,
  writeSummaryJson,
  type CommentSummary,
} from './publish/summary.js';
import { reportAssetsDir } from './report/render.js';

/** The `@actions/core` functions the action uses. */
export interface ActionCore {
  info(m: string): void;
  warning(m: string): void;
  debug(m: string): void;
  setFailed(m: string): void;
  setOutput(name: string, value: string): void;
  summary: SummaryWriter;
}

/** The part of `github.context` the action reads. */
export interface ActionContext {
  eventName: string;
  payload: Record<string, unknown>;
  repo: { owner: string; repo: string };
  runId: number;
  serverUrl: string;
}

interface PullRequest {
  number: number;
  state: string;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { repo: { full_name: string } };
}

export type ActionOctokit = CommentOctokit &
  ArtifactOctokit & {
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit(p: {
          owner: string;
          repo: string;
          commit_sha: string;
          per_page?: number;
        }): Promise<{ data: PullRequest[] }>;
      };
      pulls: {
        get(p: { owner: string; repo: string; pull_number: number }): Promise<{
          data: PullRequest;
        }>;
      };
    };
  };

export interface RunDeps {
  inputs: ActionInputs;
  context: ActionContext;
  /** Null when no `github-token` was given. */
  octokit: ActionOctokit | null;
  core: ActionCore;
  pipeline: typeof runPipeline;
  upload: typeof uploadReport;
  download: typeof downloadSummary;
}

const FORK_HINT =
  'Pull requests from forks get a read-only token, so the report is only in the job summary ' +
  'and the artifact. To comment on them, see "Fork pull requests" in the README.';
const PERMISSION_HINT = 'The token needs the pull-requests: write permission.';

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function str(x: unknown): string | null {
  return typeof x === 'string' && x !== '' ? x : null;
}

function pullRequestOf(
  payload: Record<string, unknown>,
): { number: number; base: string; head: string } | null {
  const pr = payload['pull_request'];
  if (!isRecord(pr) || typeof pr['number'] !== 'number') return null;
  const base = isRecord(pr['base']) ? str(pr['base']['sha']) : null;
  const head = isRecord(pr['head']) ? str(pr['head']['sha']) : null;
  return base && head ? { number: pr['number'], base, head } : null;
}

function setOutputs(
  c: ActionCore,
  o: {
    reportPath?: string | null;
    graphPath?: string | null;
    files: number;
    edges: number;
    skipped: boolean;
  },
): void {
  c.setOutput('report-path', o.reportPath ?? '');
  c.setOutput('graph-path', o.graphPath ?? '');
  c.setOutput('files-changed', String(o.files));
  c.setOutput('edges-count', String(o.edges));
  c.setOutput('skipped', String(o.skipped));
}

function runUrl(ctx: ActionContext, runId: number): string {
  return `${ctx.serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}/actions/runs/${runId}`;
}

function isForbidden(e: unknown): boolean {
  if (!isRecord(e)) return false;
  return (
    e['status'] === 403 ||
    (typeof e['message'] === 'string' &&
      e['message'].includes('Resource not accessible by integration'))
  );
}

/** The job summary is best effort: it is missing outside Actions. */
async function jobSummary(deps: RunDeps, s: CommentSummary, links: Links): Promise<void> {
  try {
    await writeJobSummary(s, links, deps.core.summary);
  } catch (e) {
    deps.core.warning(`could not write the job summary: ${(e as Error).message}`);
  }
}

/** Posts or updates the sticky comment; a 403 (fork PR, read-only token) only warns. */
async function comment(
  deps: RunDeps,
  issueNumber: number,
  s: CommentSummary,
  links: Links,
): Promise<void> {
  const { core: c, octokit } = deps;
  if (!octokit) {
    c.warning('no github-token was given, so no comment was posted');
    return;
  }
  try {
    const result = await upsertStickyComment(octokit, {
      ...deps.context.repo,
      issueNumber,
      body: buildCommentBody(s, links),
      updateOnly: s.skipped,
    });
    c.info(result === 'none' ? 'no sticky comment to update' : `sticky comment ${result}`);
  } catch (e) {
    if (!isForbidden(e)) throw e;
    const hint = deps.inputs.mode === 'full' ? FORK_HINT : PERMISSION_HINT;
    c.warning(
      `could not comment on pull request #${issueNumber} (${(e as Error).message}). ${hint}`,
    );
  }
}

/** `mode: full` and `mode: report`: build the report from the checked-out PR. */
async function reportMode(deps: RunDeps): Promise<void> {
  const { inputs, context, core: c } = deps;
  const pr = pullRequestOf(context.payload);
  if (!pr) {
    c.info(`pr-diff-graph runs on pull_request events (this is ${context.eventName}); skipping`);
    setOutputs(c, { files: 0, edges: 0, skipped: true });
    return;
  }
  const workspace = process.env['GITHUB_WORKSPACE'];
  if (!workspace)
    throw new Error('GITHUB_WORKSPACE is not set; run this step after actions/checkout');
  const outDir = join(process.env['RUNNER_TEMP'] || tmpdir(), 'pr-diff-graph');
  const { owner, repo } = context.repo;

  const result = await deps.pipeline({
    repo: workspace,
    base: pr.base,
    head: pr.head,
    outDir,
    minFiles: inputs.minFiles,
    include: inputs.include,
    exclude: inputs.exclude,
    clusterDepth: inputs.clusterDepth,
    collapseThreshold: inputs.collapseThreshold,
    scanRepo: inputs.scanRepo,
    maxPatchBytes: inputs.maxPatchBytes,
    prNumber: pr.number,
    repoSlug: `${owner}/${repo}`,
    log: actionsLogger(c),
    grammarDir: grammarDir(),
    assetsDir: reportAssetsDir(),
  });
  const summary = toCommentSummary(result, inputs.minFiles, pr.head);
  setOutputs(c, {
    reportPath: result.reportPath,
    graphPath: result.graphPath,
    files: result.filesChanged,
    edges: result.graph?.summary.edges ?? 0,
    skipped: result.skipped,
  });

  const links: Links = { artifactUrl: null, runUrl: runUrl(context, context.runId) };
  // The job summary is written even when an upload fails.
  try {
    const days = inputs.retentionDays;
    if (!result.skipped) {
      const files = [result.reportPath, result.graphPath, result.summaryPath].filter(
        (p): p is string => p !== null,
      );
      links.artifactUrl = (await deps.upload(files, outDir, inputs.artifactName, days)).url;
    }
    if (inputs.mode === 'report') {
      // The comment workflow of the fork pattern downloads only this small artifact; skipped
      // PRs get one too, so it can update an existing comment when a PR shrinks.
      await mkdir(outDir, { recursive: true });
      const path = result.summaryPath ?? (await writeSummaryJson(outDir, summary));
      await deps.upload([path], outDir, summaryArtifactName(inputs.artifactName), days);
    }
  } finally {
    await jobSummary(deps, summary, links);
  }
  if (inputs.mode === 'full' && inputs.comment) await comment(deps, pr.number, summary, links);
}

/** The fields of a `workflow_run` event that comment mode binds to. */
interface TriggeringRun {
  id: number;
  headSha: string;
  headBranch: string | null;
  headRepo: string | null;
  pullRequests: unknown[];
}

function triggeringRun(wr: Record<string, unknown>): TriggeringRun | null {
  const id = wr['id'];
  const headSha = str(wr['head_sha']);
  if (typeof id !== 'number' || !headSha) return null;
  const headRepo = isRecord(wr['head_repository']) ? str(wr['head_repository']['full_name']) : null;
  const prs = wr['pull_requests'];
  return {
    id,
    headSha,
    headBranch: str(wr['head_branch']),
    headRepo,
    pullRequests: Array.isArray(prs) ? prs : [],
  };
}

function sameName(a: string | null | undefined, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether a repo object of a `workflow_run.pull_requests[]` entry is this repo. Those objects
 * carry `id`, `url` and `name` but no `full_name`; the id is compared with the event's
 * `repository.id`, else the API URL's `/repos/<owner>/<repo>` tail.
 */
function isThisRepo(r: unknown, ctx: ActionContext): boolean {
  if (!isRecord(r)) return false;
  const full = `${ctx.repo.owner}/${ctx.repo.repo}`;
  if (typeof r['full_name'] === 'string') return sameName(r['full_name'], full);
  const repository = ctx.payload['repository'];
  const thisId = isRecord(repository) ? repository['id'] : undefined;
  if (typeof r['id'] === 'number' && typeof thisId === 'number') return r['id'] === thisId;
  return (
    typeof r['url'] === 'string' && r['url'].toLowerCase().endsWith(`/repos/${full}`.toLowerCase())
  );
}

type Found = { number: number } | { none: string } | { ambiguous: number[] };

/**
 * The PR of the triggering run: an event-listed PR into this repo with the run's head SHA, else
 * (fork PRs are not listed) the one open PR into this repo whose head is the run's SHA, repo
 * and branch.
 */
async function findPullRequest(
  octokit: ActionOctokit,
  ctx: ActionContext,
  wr: TriggeringRun,
): Promise<Found> {
  const listed = wr.pullRequests.flatMap((p) => {
    if (!isRecord(p) || typeof p['number'] !== 'number') return [];
    const base = isRecord(p['base']) ? p['base'] : {};
    const head = isRecord(p['head']) ? p['head'] : {};
    return isThisRepo(base['repo'], ctx) && head['sha'] === wr.headSha ? [p['number']] : [];
  });
  if (listed.length === 1) return { number: listed[0]! };
  if (listed.length > 1) return { ambiguous: listed };

  if (!wr.headRepo || !wr.headBranch) {
    return { none: 'the event names no head repository or branch to look the PR up by' };
  }
  const full = `${ctx.repo.owner}/${ctx.repo.repo}`;
  const { data } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
    ...ctx.repo,
    commit_sha: wr.headSha,
    per_page: 100,
  });
  const found = data
    .filter(
      (p) =>
        p.state === 'open' &&
        p.head.sha === wr.headSha &&
        sameName(p.base.repo.full_name, full) &&
        sameName(p.head.repo?.full_name, wr.headRepo!) &&
        p.head.ref === wr.headBranch,
    )
    .map((p) => p.number);
  if (found.length === 1) return { number: found[0]! };
  if (found.length > 1) return { ambiguous: found };
  return { none: `no open pull request into ${full} has head ${wr.headSha}` };
}

/**
 * `mode: comment` (the `workflow_run` half of the fork pattern): comment from the
 * `summary.json` of the triggering run's summary artifact. Everything is bound to that run: it
 * must be a successful `pull_request` run, the PR is found from the event (never from the file)
 * and re-checked with the API, and the file is validated and must name the run's head SHA.
 */
async function commentMode(deps: RunDeps): Promise<void> {
  const { inputs, context, core: c } = deps;
  const event = context.payload['workflow_run'];
  if (context.eventName !== 'workflow_run' || !isRecord(event)) {
    c.info(`mode: comment runs on workflow_run events (this is ${context.eventName}); skipping`);
    return;
  }
  if (event['event'] !== 'pull_request') {
    c.info(
      `the triggering run was for a ${String(event['event'])} event, not pull_request; skipping`,
    );
    return;
  }
  if (event['conclusion'] !== 'success') {
    c.info(`the triggering run concluded with ${String(event['conclusion'])}; nothing to comment`);
    return;
  }
  const wr = triggeringRun(event);
  if (!wr) throw new Error('workflow_run event without id or head_sha');
  const octokit = deps.octokit;
  if (!octokit) throw new Error('mode: comment needs github-token');

  const found = await findPullRequest(octokit, context, wr);
  if ('ambiguous' in found) {
    c.warning(
      `pull requests ${found.ambiguous.map((n) => `#${n}`).join(', ')} all match the ` +
        `triggering run's head ${wr.headSha}; not commenting`,
    );
    return;
  }
  if ('none' in found) {
    c.info(`${found.none}; nothing to comment`);
    return;
  }
  const { data: pr } = await octokit.rest.pulls.get({ ...context.repo, pull_number: found.number });
  const full = `${context.repo.owner}/${context.repo.repo}`;
  if (
    pr.state !== 'open' ||
    pr.head.sha !== wr.headSha ||
    !sameName(pr.base.repo.full_name, full)
  ) {
    c.warning(
      `pull request #${found.number} is no longer open with head ${wr.headSha} into ${full}; ` +
        'not commenting',
    );
    return;
  }

  const { summary: raw, reportArtifactId } = await deps.download(octokit, {
    ...context.repo,
    runId: wr.id,
    artifactName: inputs.artifactName,
  });
  const s = parseSummaryJson(raw);
  if (s.headSha !== wr.headSha) {
    c.warning(
      `summary.json is for head ${s.headSha}, not the triggering run's ${wr.headSha}; ` +
        'not commenting',
    );
    return;
  }
  const run = runUrl(context, wr.id);
  setOutputs(c, { files: s.files, edges: s.edges, skipped: s.skipped });

  const artifactUrl =
    s.skipped || reportArtifactId === null ? null : `${run}/artifacts/${reportArtifactId}`;
  const links = { artifactUrl, runUrl: run };
  await jobSummary(deps, s, links);
  if (inputs.comment) await comment(deps, found.number, s, links);
}

export async function run(deps: RunDeps): Promise<void> {
  try {
    if (!deps.context.eventName) {
      throw new Error('not running in GitHub Actions: GITHUB_EVENT_NAME is not set');
    }
    if (deps.inputs.mode === 'comment') await commentMode(deps);
    else await reportMode(deps);
  } catch (e) {
    deps.core.setFailed(e instanceof Error ? e.message : String(e));
  }
}

async function main(): Promise<void> {
  let inputs: ActionInputs;
  try {
    inputs = parseInputs((name) => core.getInput(name));
  } catch (e) {
    core.setFailed((e as Error).message);
    return;
  }
  await run({
    inputs,
    context: github.context,
    octokit: inputs.token ? github.getOctokit(inputs.token) : null,
    core,
    pipeline: runPipeline,
    upload: uploadReport,
    download: downloadSummary,
  });
}

if (isEntryPoint(import.meta.url)) await main();
