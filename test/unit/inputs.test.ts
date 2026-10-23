import { describe, expect, it } from 'vitest';
import { DEFAULTS, parseInputs } from '../../src/inputs.js';

const from =
  (values: Record<string, string>) =>
  (name: string): string =>
    values[name] ?? '';

describe('parseInputs', () => {
  it('defaults match the spec table', () => {
    expect(parseInputs(from({}))).toEqual({
      minFiles: 50,
      mode: 'full',
      token: '',
      comment: true,
      clusterDepth: 2,
      collapseThreshold: 150,
      scanRepo: false,
      maxPatchBytes: 200000,
      include: [],
      exclude: [],
      artifactName: 'pr-diff-graph',
      retentionDays: 14,
    });
    expect(DEFAULTS.minFiles).toBe(50);
  });

  it('reads every input', () => {
    const inputs = parseInputs(
      from({
        'min-files': '0',
        mode: 'comment',
        'github-token': 't',
        comment: 'FALSE',
        'cluster-depth': '3',
        'collapse-threshold': '10',
        'scan-repo': 'true',
        'max-patch-bytes': '1000',
        'artifact-name': 'graph',
        'artifact-retention-days': '1',
      }),
    );
    expect(inputs).toMatchObject({
      minFiles: 0,
      mode: 'comment',
      token: 't',
      comment: false,
      clusterDepth: 3,
      collapseThreshold: 10,
      scanRepo: true,
      maxPatchBytes: 1000,
      artifactName: 'graph',
      retentionDays: 1,
    });
  });

  it('rejects min-files=abc naming the input', () => {
    expect(() => parseInputs(from({ 'min-files': 'abc' }))).toThrow(/min-files/);
    expect(() => parseInputs(from({ 'cluster-depth': '0' }))).toThrow(/cluster-depth/);
    expect(() => parseInputs(from({ 'max-patch-bytes': '1.5' }))).toThrow(/max-patch-bytes/);
    expect(() => parseInputs(from({ 'artifact-retention-days': '91' }))).toThrow(
      /artifact-retention-days/,
    );
    expect(() => parseInputs(from({ mode: 'pages' }))).toThrow(/mode/);
    expect(() => parseInputs(from({ comment: 'yes' }))).toThrow(/comment/);
  });

  it('newline-separated globs', () => {
    const inputs = parseInputs(
      from({ include: 'src/**\r\n\n  lib/*.ts  \n', exclude: '**/*.lock\n# a comment\n' }),
    );
    expect(inputs.include).toEqual(['src/**', 'lib/*.ts']);
    expect(inputs.exclude).toEqual(['**/*.lock']);
  });
});
