import * as core from '@actions/core';
import { buildSummaryMarkdown, type Links } from './comment.js';
import type { CommentSummary } from './summary.js';

/** The part of `core.summary` used here. */
export interface SummaryWriter {
  addRaw(text: string, addEOL?: boolean): { write(): Promise<unknown> };
}

/** Appends the summary to the job summary (`$GITHUB_STEP_SUMMARY`). */
export async function writeJobSummary(
  s: CommentSummary,
  links: Links,
  summary: SummaryWriter = core.summary,
): Promise<void> {
  await summary.addRaw(buildSummaryMarkdown(s, links), true).write();
}
