import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphJson } from '../../src/graph/types.js';
import { DEFAULTS, type ActionInputs } from '../../src/inputs.js';
import { run, type RunDeps } from '../../src/main.js';
import type { PipelineResult } from '../../src/pipeline.js';
import { MARKER } from '../../src/publish/comment.js';
import type { CommentSummary } from '../../src/publish/summary.js';
import {
  fakeOctokit,
  httpError,
  type FakeOptions,
  type FakePullRequest,
} from '../helpers/fakeoctokit.js';

const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const bot = { login: 'github-actions[bot]', type: 'Bot' };

const graph = {
  summary: {
    files: 60,
    additions: 10,
    deletions: 5,
    edges: 70,
    cycles: 1,
    unresolved: 3,
    parseErrors: 0,
    binary: 0,
    rawFiles: 61,
    externals: 0,
  },
  ranking: ['src/a.ts'],
  clusters: [],
  nodes: [],
  edges: [],
  cycles: [],
} as unknown as GraphJson;

const okResult: PipelineResult = {
  skipped: false,
  filesChanged: 60,
  rawFilesChanged: 61,
  graph,
  reportPath: '/out/report.html',
  graphPath: '/out/graph.json',
  summaryPath: '/out/summary.json',
};

const skippedResult: PipelineResult = {
  skipped: true,
  filesChanged: 12,
  rawFilesChanged: 12,
  graph: null,
  reportPath: null,
  graphPath: null,
  summaryPath: null,
};

function fakeCore() {
  const summary = {
    text: '',
    addRaw: vi.fn((t: string) => {
      summary.text += t;
      return summary;
    }),
    write: vi.fn(async () => summary),
  };
  return {
    info: vi.fn(),
    warning: vi.fn(),
    debug: vi.fn(),
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    summary,
  };
}

function prContext(eventName = 'pull_request'): RunDeps['context'] {
  return {
    eventName,
    payload: { pull_request: { number: 7, base: { sha: BASE }, head: { sha: HEAD } } },
    repo: { owner: 'o', repo: 'r' },
    runId: 99,
    serverUrl: 'https://github.com',
  };
}

function workflowRunContext(wr: Record<string, unknown>): RunDeps['context'] {
  return {
    eventName: 'workflow_run',
    payload: {
      workflow_run: {
        id: 42,
        event: 'pull_request',
        conclusion: 'success',
        head_sha: HEAD,
        head_branch: 'feat',
        head_repository: { full_name: 'fork/r' },
        pull_requests: [],
        ...wr,
      },
      repository: { id: 1, full_name: 'o/r' },
    },
    repo: { owner: 'o', repo: 'r' },
    runId: 100,
    serverUrl: 'https://github.com',
  };
}

/** An open PR into o/r from fork/r:feat at HEAD, as the REST API returns it. */
function openPr(
  number: number,
  over: { state?: string; sha?: string; ref?: string; headRepo?: string; base?: string } = {},
): FakePullRequest {
  return {
    number,
    state: over.state ?? 'open',
    head: {
      sha: over.sha ?? HEAD,
      ref: over.ref ?? 'feat',
      repo: { full_name: over.headRepo ?? 'fork/r' },
    },
    base: { repo: { full_name: over.base ?? 'o/r' } },
  };
}

const validSummary: CommentSummary = {
  version: 1,
  skipped: false,
  minFiles: 50,
  files: 60,
  additions: 10,
  deletions: 5,
  edges: 70,
  cycles: 1,
  unresolved: 3,
  parseErrors: 0,
  top: ['src/a.ts'],
  headSha: HEAD,
};

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pdg-main-'));
  vi.stubEnv('GITHUB_WORKSPACE', '/work');
  vi.stubEnv('RUNNER_TEMP', tmp);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

function setup(
  over: {
    inputs?: Partial<ActionInputs>;
    context?: RunDeps['context'];
    octokit?: FakeOptions;
    result?: PipelineResult | Error;
    summaryJson?: string | Error;
  } = {},
) {
  const core = fakeCore();
  const octokit = fakeOctokit(over.octokit);
  const result = over.result ?? okResult;
  const deps = {
    inputs: { ...DEFAULTS, token: 'tok', include: [], exclude: [], ...over.inputs },
    context: over.context ?? prContext(),
    octokit,
    core,
    pipeline: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    upload: vi.fn(async () => ({
      id: 5,
      url: 'https://github.com/o/r/actions/runs/99/artifacts/5',
    })),
    download: vi.fn(async () => {
      const s = over.summaryJson ?? JSON.stringify(validSummary);
      if (s instanceof Error) throw s;
      return { summary: s, reportArtifactId: 8 };
    }),
  } satisfies RunDeps;
  return { deps, core, octokit };
}

function outputs(core: ReturnType<typeof fakeCore>): Record<string, unknown> {
  return Object.fromEntries(core.setOutput.mock.calls);
}

function firstArg<T>(fn: { mock: { calls: unknown[][] } }): T {
  return fn.mock.calls[0]?.[0] as T;
}

describe('run, mode: full', () => {
  it('skips on non-pull_request events with an info log', async () => {
    const { deps, core } = setup({ context: { ...prContext('push'), payload: {} } });
    await run(deps);
    expect(deps.pipeline).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringMatching(/pull_request/));
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(outputs(core)['skipped']).toBe('true');
  });

  it('runs the pipeline on the PR SHAs in the workspace', async () => {
    const { deps } = setup();
    await run(deps);
    expect(deps.pipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: '/work',
        base: BASE,
        head: HEAD,
        outDir: join(tmp, 'pr-diff-graph'),
        minFiles: 50,
        prNumber: 7,
        repoSlug: 'o/r',
      }),
    );
  });

  it('below threshold sets skipped=true and updates an existing comment to the skipped body', async () => {
    const { deps, core, octokit } = setup({
      result: skippedResult,
      octokit: { comments: [{ id: 3, body: `${MARKER}\nold`, user: bot }] },
    });
    await run(deps);
    expect(outputs(core)).toMatchObject({ skipped: 'true', 'files-changed': '12' });
    expect(deps.upload).not.toHaveBeenCalled();
    const call = firstArg<{ comment_id: number; body: string }>(octokit.rest.issues.updateComment);
    expect(call.comment_id).toBe(3);
    expect(call.body).toMatch(/at or under/);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('below threshold never creates a comment', async () => {
    const { deps, octokit } = setup({ result: skippedResult });
    await run(deps);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('uploads artifact, comments, sets outputs report-path/graph-path/files-changed/edges-count/skipped', async () => {
    const { deps, core, octokit } = setup();
    await run(deps);
    expect(deps.upload).toHaveBeenCalledWith(
      ['/out/report.html', '/out/graph.json', '/out/summary.json'],
      join(tmp, 'pr-diff-graph'),
      'pr-diff-graph',
      14,
    );
    const call = firstArg<{ issue_number: number; body: string }>(
      octokit.rest.issues.createComment,
    );
    expect(call.issue_number).toBe(7);
    expect(call.body).toContain('/actions/runs/99/artifacts/5');
    expect(outputs(core)).toEqual({
      'report-path': '/out/report.html',
      'graph-path': '/out/graph.json',
      'files-changed': '60',
      'edges-count': '70',
      skipped: 'false',
    });
    expect(core.summary.write).toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('comment: false posts nothing', async () => {
    const { deps, octokit } = setup({ inputs: { comment: false } });
    await run(deps);
    expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();
    expect(deps.upload).toHaveBeenCalled();
  });

  it('403 on comment warns, writes job summary, does not fail', async () => {
    const { deps, core } = setup({
      octokit: { writeError: httpError(403, 'Resource not accessible by integration') },
    });
    await run(deps);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/Fork pull requests/));
    expect(core.summary.write).toHaveBeenCalled();
    expect(core.summary.text).toContain('60');
    expect(outputs(core)['skipped']).toBe('false');
  });

  it('other comment errors fail the run', async () => {
    const { deps, core } = setup({ octokit: { writeError: httpError(500, 'boom') } });
    await run(deps);
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('pipeline error calls core.setFailed with the message', async () => {
    const { deps, core } = setup({
      result: new Error('merge base not found; use fetch-depth: 0'),
    });
    await run(deps);
    expect(core.setFailed).toHaveBeenCalledWith('merge base not found; use fetch-depth: 0');
  });

  it('outside GitHub Actions fails cleanly', async () => {
    const { deps, core } = setup({ context: { ...prContext(''), payload: {} } });
    await run(deps);
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(/GITHUB_EVENT_NAME/));
    expect(deps.pipeline).not.toHaveBeenCalled();
  });

  it('a missing GITHUB_WORKSPACE fails cleanly', async () => {
    vi.stubEnv('GITHUB_WORKSPACE', '');
    const { deps, core } = setup();
    await run(deps);
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(/GITHUB_WORKSPACE/));
  });
});

describe('run, mode: report', () => {
  it('never calls the comment API', async () => {
    const { deps, octokit } = setup({ inputs: { mode: 'report' } });
    await run(deps);
    expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.users.getAuthenticated).not.toHaveBeenCalled();
  });

  it('uploads the report artifact with summary.json, and summary.json as its own artifact', async () => {
    const { deps } = setup({ inputs: { mode: 'report' } });
    await run(deps);
    const out = join(tmp, 'pr-diff-graph');
    expect(deps.upload.mock.calls).toEqual([
      [['/out/report.html', '/out/graph.json', '/out/summary.json'], out, 'pr-diff-graph', 14],
      [['/out/summary.json'], out, 'pr-diff-graph-summary', 14],
    ]);
  });

  it('below threshold uploads a skipped summary.json so the comment workflow can update', async () => {
    const { deps } = setup({ inputs: { mode: 'report' }, result: skippedResult });
    await run(deps);
    expect(deps.upload).toHaveBeenCalledTimes(1);
    const [files, root, name] = deps.upload.mock.calls[0] as unknown as [string[], string, string];
    expect(files).toEqual([join(tmp, 'pr-diff-graph', 'summary.json')]);
    expect(root).toBe(join(tmp, 'pr-diff-graph'));
    expect(name).toBe('pr-diff-graph-summary');
    const s = JSON.parse(await readFile(files[0]!, 'utf8')) as CommentSummary;
    expect(s).toMatchObject({ version: 1, skipped: true, files: 12, headSha: HEAD });
  });

  it('an upload failure still writes the job summary', async () => {
    const { deps, core } = setup({ inputs: { mode: 'report' } });
    deps.upload.mockRejectedValueOnce(new Error('upload broke'));
    await run(deps);
    expect(core.summary.write).toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith('upload broke');
  });
});

describe('run, mode: comment', () => {
  const comment = { mode: 'comment' as const };
  const listed = { number: 31, head: { sha: HEAD }, base: { repo: { id: 1, name: 'r' } } };

  it('takes the PR number from workflow_run.pull_requests[0]', async () => {
    const { deps, octokit } = setup({
      inputs: comment,
      context: workflowRunContext({ pull_requests: [listed] }),
      octokit: { pullRequests: [openPr(31)] },
    });
    await run(deps);
    expect(deps.pipeline).not.toHaveBeenCalled();
    expect(deps.download).toHaveBeenCalledWith(octokit, {
      owner: 'o',
      repo: 'r',
      runId: 42,
      artifactName: 'pr-diff-graph',
    });
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({ owner: 'o', repo: 'r', pull_number: 31 });
    const call = firstArg<{ issue_number: number; body: string }>(
      octokit.rest.issues.createComment,
    );
    expect(call.issue_number).toBe(31);
    expect(call.body).toContain('/actions/runs/42/artifacts/8');
    expect(octokit.rest.repos.listPullRequestsAssociatedWithCommit).not.toHaveBeenCalled();
  });

  it('ignores a listed PR whose base is another repo, or whose head is another SHA', async () => {
    const { deps, octokit } = setup({
      inputs: comment,
      context: workflowRunContext({
        pull_requests: [
          { ...listed, number: 1, base: { repo: { id: 999, name: 'r' } } },
          { ...listed, number: 2, head: { sha: 'd'.repeat(40) } },
        ],
      }),
      octokit: { pullRequests: [openPr(1), openPr(2)] },
    });
    await run(deps);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.repos.listPullRequestsAssociatedWithCommit).toHaveBeenCalled();
    expect(deps.download).not.toHaveBeenCalled();
  });

  it('matches a listed PR by repo URL when ids are missing', async () => {
    const { deps, octokit } = setup({
      inputs: comment,
      context: workflowRunContext({
        pull_requests: [{ ...listed, base: { repo: { url: 'https://api.github.com/repos/O/R' } } }],
      }),
      octokit: { pullRequests: [openPr(31)] },
    });
    await run(deps);
    expect(firstArg<{ issue_number: number }>(octokit.rest.issues.createComment)).toMatchObject({
      issue_number: 31,
    });
  });

  it('does not comment on a closed or stale PR', async () => {
    for (const pr of [openPr(31, { state: 'closed' }), openPr(31, { sha: 'e'.repeat(40) })]) {
      const { deps, core, octokit } = setup({
        inputs: comment,
        context: workflowRunContext({ pull_requests: [listed] }),
        octokit: { pullRequests: [pr] },
      });
      await run(deps);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(deps.download).not.toHaveBeenCalled();
      expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/no longer open/));
      expect(core.setFailed).not.toHaveBeenCalled();
    }
  });

  it('falls back to searching PRs by head SHA when pull_requests is empty (fork)', async () => {
    const { deps, octokit } = setup({
      inputs: comment,
      context: workflowRunContext({}),
      octokit: {
        pullRequests: [
          openPr(1, { state: 'closed' }),
          openPr(2, { sha: 'd'.repeat(40) }),
          openPr(4, { base: 'someone/else' }),
          openPr(5, { headRepo: 'other/fork' }),
          openPr(6, { ref: 'other-branch' }),
          openPr(3),
        ],
      },
    });
    await run(deps);
    expect(octokit.rest.repos.listPullRequestsAssociatedWithCommit).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'o', repo: 'r', commit_sha: HEAD }),
    );
    expect(firstArg<{ issue_number: number }>(octokit.rest.issues.createComment)).toMatchObject({
      issue_number: 3,
    });
  });

  it('refuses to comment when two PRs match in the fallback', async () => {
    const { deps, core, octokit } = setup({
      inputs: comment,
      context: workflowRunContext({}),
      octokit: { pullRequests: [openPr(3), openPr(7)] },
    });
    await run(deps);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(deps.download).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/#3, #7/));
  });

  it('does nothing when no open PR matches the head SHA', async () => {
    const { deps, core, octokit } = setup({ inputs: comment, context: workflowRunContext({}) });
    await run(deps);
    expect(deps.download).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringMatching(/no open pull request/i));
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('ignores any PR number in summary.json', async () => {
    const { deps, core, octokit } = setup({
      inputs: comment,
      context: workflowRunContext({ pull_requests: [listed] }),
      octokit: { pullRequests: [openPr(31)] },
      summaryJson: JSON.stringify({ ...validSummary, prNumber: 1 }),
    });
    await run(deps);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(/summary\.json/));
  });

  it('does not comment when summary.json names another head SHA', async () => {
    const { deps, core, octokit } = setup({
      inputs: comment,
      context: workflowRunContext({ pull_requests: [listed] }),
      octokit: { pullRequests: [openPr(31)] },
      summaryJson: JSON.stringify({ ...validSummary, headSha: 'f'.repeat(40) }),
    });
    await run(deps);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/summary\.json is for head/));
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('does nothing when the workflow_run concluded with failure', async () => {
    const { deps, core, octokit } = setup({
      inputs: comment,
      context: workflowRunContext({ conclusion: 'failure', pull_requests: [listed] }),
      octokit: { pullRequests: [openPr(31)] },
    });
    await run(deps);
    expect(deps.download).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringMatching(/failure/));
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('does nothing when the triggering run was not for a pull_request event', async () => {
    const { deps, core, octokit } = setup({
      inputs: comment,
      context: workflowRunContext({ event: 'push', pull_requests: [listed] }),
      octokit: { pullRequests: [openPr(31)] },
    });
    await run(deps);
    expect(deps.download).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringMatching(/push event, not pull_request/));
  });

  it('rejects an oversized summary', async () => {
    const { deps, core, octokit } = setup({
      inputs: comment,
      context: workflowRunContext({ pull_requests: [listed] }),
      octokit: { pullRequests: [openPr(31)] },
      summaryJson: new Error('summary.json is larger than 64 KB'),
    });
    await run(deps);
    expect(core.setFailed).toHaveBeenCalledWith('summary.json is larger than 64 KB');
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('a skipped summary only updates an existing comment', async () => {
    const { deps, octokit } = setup({
      inputs: comment,
      context: workflowRunContext({ pull_requests: [listed] }),
      octokit: { pullRequests: [openPr(31)] },
      summaryJson: JSON.stringify({ ...validSummary, skipped: true, files: 3, top: [] }),
    });
    await run(deps);
    expect(octokit.rest.issues.listComments).toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('403 on comment names the missing permission, not the fork pattern', async () => {
    const { deps, core } = setup({
      inputs: comment,
      context: workflowRunContext({ pull_requests: [listed] }),
      octokit: {
        pullRequests: [openPr(31)],
        writeError: httpError(403, 'Resource not accessible by integration'),
      },
    });
    await run(deps);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/pull-requests: write/));
    expect(core.warning).not.toHaveBeenCalledWith(expect.stringMatching(/Fork pull requests/));
  });

  it('only runs on workflow_run events', async () => {
    const { deps, core } = setup({ inputs: comment });
    await run(deps);
    expect(deps.download).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringMatching(/workflow_run/));
  });
});
