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
import { downloadSummary, uploadReport, type ArtifactOctokit } from './publish/artifact.js';
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

interface AssociatedPr {
  number: number;
  state: string;
  head: { sha: string };
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
        }): Promise<{ data: AssociatedPr[] }>;
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
    c.warning(
      `could not comment on pull request #${issueNumber} (${(e as Error).message}). ${FORK_HINT}`,
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

  let artifactUrl: string | null = null;
  if (!result.skipped) {
    const files = [result.reportPath, result.graphPath, result.summaryPath].filter(
      (p): p is string => p !== null,
    );
    artifactUrl = (await deps.upload(files, outDir, inputs.artifactName, inputs.retentionDays)).url;
  } else if (inputs.mode === 'report') {
    // The comment workflow of the fork pattern needs the skipped summary to update its comment.
    await mkdir(outDir, { recursive: true });
    const path = await writeSummaryJson(outDir, summary);
    await deps.upload([path], outDir, inputs.artifactName, inputs.retentionDays);
  }

  const links = { artifactUrl, runUrl: runUrl(context, context.runId) };
  await jobSummary(deps, summary, links);
  if (inputs.mode === 'full' && inputs.comment) await comment(deps, pr.number, summary, links);
}

/** The open PR whose head is `sha`: from the event, else looked up (fork PRs are not listed). */
async function findPullRequest(
  octokit: ActionOctokit,
  ctx: ActionContext,
  listed: unknown,
  sha: string,
): Promise<number | null> {
  const first = Array.isArray(listed) ? (listed[0] as unknown) : undefined;
  if (isRecord(first) && typeof first['number'] === 'number') return first['number'];
  const { data } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
    ...ctx.repo,
    commit_sha: sha,
    per_page: 100,
  });
  return data.find((p) => p.state === 'open' && p.head.sha === sha)?.number ?? null;
}

/**
 * `mode: comment` (the `workflow_run` half of the fork pattern): comment from the
 * `summary.json` of the triggering run's artifact. The file is hostile: it is validated, and
 * the PR number comes from the event, never from it.
 */
async function commentMode(deps: RunDeps): Promise<void> {
  const { inputs, context, core: c } = deps;
  const wr = context.payload['workflow_run'];
  if (context.eventName !== 'workflow_run' || !isRecord(wr)) {
    c.info(`mode: comment runs on workflow_run events (this is ${context.eventName}); skipping`);
    return;
  }
  if (wr['conclusion'] !== 'success') {
    c.info(`the triggering run concluded with ${String(wr['conclusion'])}; nothing to comment`);
    return;
  }
  const runId = wr['id'];
  const headSha = str(wr['head_sha']);
  if (typeof runId !== 'number' || !headSha)
    throw new Error('workflow_run event without id or head_sha');
  if (!deps.octokit) throw new Error('mode: comment needs github-token');

  const prNumber = await findPullRequest(deps.octokit, context, wr['pull_requests'], headSha);
  if (prNumber === null) {
    c.info(`no open pull request has head ${headSha}; nothing to comment`);
    return;
  }
  const { summary: raw, artifactId } = await deps.download(deps.octokit, {
    ...context.repo,
    runId,
    artifactName: inputs.artifactName,
  });
  const s = parseSummaryJson(raw);
  const run = runUrl(context, runId);
  setOutputs(c, { files: s.files, edges: s.edges, skipped: s.skipped });

  const links = { artifactUrl: s.skipped ? null : `${run}/artifacts/${artifactId}`, runUrl: run };
  await jobSummary(deps, s, links);
  if (inputs.comment) await comment(deps, prNumber, s, links);
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
