import { DefaultArtifactClient } from '@actions/artifact';
import { unzipSync } from 'fflate';

/** Largest `summary.json` accepted from another workflow's artifact. */
export const MAX_SUMMARY_BYTES = 64 * 1024;
/** Largest summary artifact zip `mode: comment` downloads. */
export const MAX_SUMMARY_ZIP_BYTES = 1024 * 1024;

/** The small artifact holding only summary.json, uploaded next to the report artifact `name`. */
export function summaryArtifactName(name: string): string {
  return `${name}-summary`;
}

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
 * Reads `summary.json` from the summary artifact (`<artifactName>-summary`) of workflow run
 * `runId` (unvalidated; see `parseSummaryJson`), and finds the id of that run's report artifact
 * (`artifactName`; null when there is none, as for a skipped PR) for the comment's link.
 */
export async function downloadSummary(
  octokit: ArtifactOctokit,
  p: { owner: string; repo: string; runId: number; artifactName: string },
): Promise<{ summary: string; reportArtifactId: number | null }> {
  const { data } = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner: p.owner,
    repo: p.repo,
    run_id: p.runId,
    per_page: 100,
  });
  const live = (name: string) => data.artifacts.find((a) => a.name === name && !a.expired);
  const name = summaryArtifactName(p.artifactName);
  const artifact = live(name);
  if (!artifact) throw new Error(`no artifact named '${name}' on run ${p.runId}`);
  const tooLarge = () =>
    new Error(`artifact '${name}' is too large (over ${MAX_SUMMARY_ZIP_BYTES} bytes)`);
  if (artifact.size_in_bytes > MAX_SUMMARY_ZIP_BYTES) throw tooLarge();

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
  if (!bytesIn) throw new Error(`artifact '${name}' download did not return a zip`);
  if (bytesIn.length > MAX_SUMMARY_ZIP_BYTES) throw tooLarge();

  let entryTooLarge = false;
  const entries = unzipSync(bytesIn, {
    filter: (f) => {
      if (f.name !== 'summary.json') return false;
      if (f.originalSize > MAX_SUMMARY_BYTES || f.size > MAX_SUMMARY_BYTES) entryTooLarge = true;
      return !entryTooLarge;
    },
  });
  const bytes = entries['summary.json'];
  if (entryTooLarge || (bytes && bytes.length > MAX_SUMMARY_BYTES)) {
    throw new Error('summary.json is larger than 64 KB');
  }
  if (!bytes) throw new Error(`artifact '${name}' has no summary.json`);
  return {
    summary: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    reportArtifactId: live(p.artifactName)?.id ?? null,
  };
}
