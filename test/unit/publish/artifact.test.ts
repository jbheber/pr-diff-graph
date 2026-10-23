import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { downloadSummary, summaryArtifactName } from '../../../src/publish/artifact.js';
import { fakeOctokit } from '../../helpers/fakeoctokit.js';

const p = { owner: 'o', repo: 'r', runId: 42, artifactName: 'pr-diff-graph' };
const report = { id: 5, name: 'pr-diff-graph', expired: false, size_in_bytes: 900_000_000 };
const summary = { id: 6, name: 'pr-diff-graph-summary', expired: false, size_in_bytes: 300 };

/** Bytes that do not compress, so the zip is at least `n` bytes. */
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

describe('downloadSummary', () => {
  it('names the summary artifact after the report artifact', () => {
    expect(summaryArtifactName('graph')).toBe('graph-summary');
  });

  it('reads summary.json from the summary artifact only, and finds the report artifact id', async () => {
    const zip = zipSync({ 'summary.json': strToU8('{"version":1}') });
    const octokit = fakeOctokit({ artifacts: [report, summary], zip });
    expect(await downloadSummary(octokit, p)).toEqual({
      summary: '{"version":1}',
      reportArtifactId: 5,
    });
    expect(octokit.rest.actions.listWorkflowRunArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'o', repo: 'r', run_id: 42 }),
    );
    expect(octokit.rest.actions.downloadArtifact).toHaveBeenCalledTimes(1);
    expect(octokit.rest.actions.downloadArtifact).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      artifact_id: 6,
      archive_format: 'zip',
    });
  });

  it('report artifact id is null when there is none (skipped PR)', async () => {
    const zip = zipSync({ 'summary.json': strToU8('{}') });
    const octokit = fakeOctokit({ artifacts: [summary], zip });
    expect((await downloadSummary(octokit, p)).reportArtifactId).toBeNull();
  });

  it('rejects an oversized summary', async () => {
    const zip = zipSync({ 'summary.json': strToU8(' '.repeat(64 * 1024 + 1)) });
    const octokit = fakeOctokit({ artifacts: [summary], zip });
    await expect(downloadSummary(octokit, p)).rejects.toThrow(/64 KB/);
  });

  it('fails when the summary artifact or summary.json is missing', async () => {
    await expect(downloadSummary(fakeOctokit({ artifacts: [report] }), p)).rejects.toThrow(
      /no artifact named 'pr-diff-graph-summary' on run 42/,
    );
    await expect(
      downloadSummary(fakeOctokit({ artifacts: [{ ...summary, expired: true }] }), p),
    ).rejects.toThrow(/no artifact/);
    const zip = zipSync({ 'report.html': strToU8('x') });
    await expect(downloadSummary(fakeOctokit({ artifacts: [summary], zip }), p)).rejects.toThrow(
      /summary\.json/,
    );
  });

  it('refuses a summary artifact over 1 MB, by listed size and by downloaded size', async () => {
    const big = { ...summary, size_in_bytes: 1024 * 1024 + 1 };
    const octokit = fakeOctokit({ artifacts: [big] });
    await expect(downloadSummary(octokit, p)).rejects.toThrow(/too large/);
    expect(octokit.rest.actions.downloadArtifact).not.toHaveBeenCalled();

    const zip = zipSync({ 'pad.bin': noise(1024 * 1024 + 1) }, { level: 0 });
    await expect(downloadSummary(fakeOctokit({ artifacts: [summary], zip }), p)).rejects.toThrow(
      /too large/,
    );
  });
});
