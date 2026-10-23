import { vi } from 'vitest';

export interface FakeComment {
  id: number;
  body?: string;
  user: { login: string; type: string } | null;
}

export interface FakeOptions {
  /** Comments on the PR, served 100 per page. */
  comments?: FakeComment[];
  /** Login returned by GET /user; null makes it fail with 403 like GITHUB_TOKEN. */
  login?: string | null;
  /** Error thrown by createComment/updateComment. */
  writeError?: Error;
  pullRequests?: { number: number; state: string; head: { sha: string } }[];
  /** Artifacts of the workflow run, and the zip every download returns. */
  artifacts?: { id: number; name: string; expired: boolean; size_in_bytes: number }[];
  zip?: Uint8Array;
}

export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** A fake of the octokit methods the action uses. */
export function fakeOctokit(o: FakeOptions = {}) {
  const comments = o.comments ?? [];
  const write = async () => {
    if (o.writeError) throw o.writeError;
    return { data: {} };
  };
  return {
    rest: {
      users: {
        getAuthenticated: vi.fn(async () => {
          if (o.login === null || o.login === undefined) {
            throw httpError(403, 'Resource not accessible by integration');
          }
          return { data: { login: o.login } };
        }),
      },
      issues: {
        listComments: vi.fn(async (p: { per_page?: number; page?: number }) => {
          const per = p.per_page ?? 30;
          const page = p.page ?? 1;
          return { data: comments.slice((page - 1) * per, page * per) };
        }),
        createComment: vi.fn(write),
        updateComment: vi.fn(write),
      },
      actions: {
        listWorkflowRunArtifacts: vi.fn(async (p: { name?: string }) => {
          const artifacts = (o.artifacts ?? []).filter((a) => !p.name || a.name === p.name);
          return { data: { total_count: artifacts.length, artifacts } };
        }),
        downloadArtifact: vi.fn(async () => {
          const zip = o.zip ?? new Uint8Array();
          return { data: zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
        }),
      },
      repos: {
        listPullRequestsAssociatedWithCommit: vi.fn(async () => ({
          data: o.pullRequests ?? [],
        })),
      },
    },
  };
}

export type FakeOctokit = ReturnType<typeof fakeOctokit>;
