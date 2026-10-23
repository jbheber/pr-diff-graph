import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { downloadSummary } from '../../../src/publish/artifact.js';
import { fakeOctokit } from '../../helpers/fakeoctokit.js';

const p = { owner: 'o', repo: 'r', runId: 42, artifactName: 'pr-diff-graph' };
const artifact = { id: 5, name: 'pr-diff-graph', expired: false, size_in_bytes: 1000 };

describe('downloadSummary', () => {
  it('returns summary.json from the run artifact', async () => {
    const zip = zipSync({
      'report.html': strToU8('<html>'),
      'summary.json': strToU8('{"version":1}'),
    });
    const octokit = fakeOctokit({ artifacts: [artifact], zip });
    expect(await downloadSummary(octokit, p)).toEqual({
      summary: '{"version":1}',
      artifactId: 5,
    });
    expect(octokit.rest.actions.listWorkflowRunArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'o', repo: 'r', run_id: 42, name: 'pr-diff-graph' }),
    );
    expect(octokit.rest.actions.downloadArtifact).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      artifact_id: 5,
      archive_format: 'zip',
    });
  });

  it('rejects an oversized summary', async () => {
    const zip = zipSync({ 'summary.json': strToU8(' '.repeat(64 * 1024 + 1)) });
    const octokit = fakeOctokit({ artifacts: [artifact], zip });
    await expect(downloadSummary(octokit, p)).rejects.toThrow(/64 KB/);
  });

  it('fails when the artifact or summary.json is missing', async () => {
    await expect(downloadSummary(fakeOctokit({ artifacts: [] }), p)).rejects.toThrow(
      /no artifact named 'pr-diff-graph' on run 42/,
    );
    await expect(
      downloadSummary(fakeOctokit({ artifacts: [{ ...artifact, expired: true }] }), p),
    ).rejects.toThrow(/no artifact/);
    const zip = zipSync({ 'report.html': strToU8('x') });
    await expect(downloadSummary(fakeOctokit({ artifacts: [artifact], zip }), p)).rejects.toThrow(
      /summary\.json/,
    );
  });

  it('refuses to download a huge artifact', async () => {
    const big = { ...artifact, size_in_bytes: 2 ** 31 };
    await expect(downloadSummary(fakeOctokit({ artifacts: [big] }), p)).rejects.toThrow(
      /too large/,
    );
  });
});
