import { DefaultArtifactClient } from '@actions/artifact';
import { unzipSync } from 'fflate';

/** Largest `summary.json` accepted from another workflow's artifact. */
export const MAX_SUMMARY_BYTES = 64 * 1024;
/** Largest artifact zip `mode: comment` downloads (it also holds the report). */
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

/** Uploads the report files; the URL is the artifact's page on the run. */
export async function uploadReport(
  files: string[],
  rootDir: string,
  name: string,
  retentionDays: number,
): Promise<{ id: number; url: string }> {
  const { id } = await new DefaultArtifactClient().uploadArtifact(name, files, rootDir, {
    retentionDays,
  });
  if (id === undefined) throw new Error(`artifact ${name} was not uploaded`);
  const env = process.env;
  const server = env['GITHUB_SERVER_URL'] ?? 'https://github.com';
  const url = `${server}/${env['GITHUB_REPOSITORY']}/actions/runs/${env['GITHUB_RUN_ID']}/artifacts/${id}`;
  return { id, url };
}

/** The octokit methods `downloadSummary` needs. */
export interface ArtifactOctokit {
  rest: {
    actions: {
      listWorkflowRunArtifacts(p: {
        owner: string;
        repo: string;
        run_id: number;
        name?: string;
        per_page?: number;
      }): Promise<{
        data: {
          artifacts: { id: number; name: string; expired: boolean; size_in_bytes: number }[];
        };
      }>;
      downloadArtifact(p: {
        owner: string;
        repo: string;
        artifact_id: number;
        archive_format: string;
      }): Promise<{ data: unknown }>;
    };
  };
}

/**
 * Downloads the artifact `artifactName` of workflow run `runId` and returns its `summary.json`
 * text (unvalidated; see `parseSummaryJson`) and the artifact id.
 */
export async function downloadSummary(
  octokit: ArtifactOctokit,
  p: { owner: string; repo: string; runId: number; artifactName: string },
): Promise<{ summary: string; artifactId: number }> {
  const { data } = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner: p.owner,
    repo: p.repo,
    run_id: p.runId,
    name: p.artifactName,
    per_page: 100,
  });
  const artifact = data.artifacts.find((a) => a.name === p.artifactName && !a.expired);
  if (!artifact) {
    throw new Error(`no artifact named '${p.artifactName}' on run ${p.runId}`);
  }
  if (artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `artifact '${p.artifactName}' is too large (${artifact.size_in_bytes} bytes) to download`,
    );
  }
  const zip = await octokit.rest.actions.downloadArtifact({
    owner: p.owner,
    repo: p.repo,
    artifact_id: artifact.id,
    archive_format: 'zip',
  });
  const raw = zip.data;
  const bytesIn = ArrayBuffer.isView(raw)
    ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    : raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : null;
  if (!bytesIn) throw new Error(`artifact '${p.artifactName}' download did not return a zip`);

  let tooLarge = false;
  const entries = unzipSync(bytesIn, {
    filter: (f) => {
      if (f.name !== 'summary.json') return false;
      if (f.originalSize > MAX_SUMMARY_BYTES || f.size > MAX_SUMMARY_BYTES) tooLarge = true;
      return !tooLarge;
    },
  });
  const bytes = entries['summary.json'];
  if (tooLarge || (bytes && bytes.length > MAX_SUMMARY_BYTES)) {
    throw new Error('summary.json is larger than 64 KB');
  }
  if (!bytes) throw new Error(`artifact '${p.artifactName}' has no summary.json`);
  return {
    summary: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    artifactId: artifact.id,
  };
}
