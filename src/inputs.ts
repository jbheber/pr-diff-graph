export type Mode = 'full' | 'report' | 'comment';

const MODES: readonly Mode[] = ['full', 'report', 'comment'];

/** Defaults of the action inputs (the spec's Inputs table), shared with the CLI. */
export const DEFAULTS = {
  minFiles: 50,
  mode: 'full' as Mode,
  comment: true,
  clusterDepth: 2,
  collapseThreshold: 150,
  scanRepo: false,
  maxPatchBytes: 200_000,
  artifactName: 'pr-diff-graph',
  retentionDays: 14,
} as const;

export interface ActionInputs {
  minFiles: number;
  mode: Mode;
  token: string;
  comment: boolean;
  clusterDepth: number;
  collapseThreshold: number;
  scanRepo: boolean;
  maxPatchBytes: number;
  include: string[];
  exclude: string[];
  artifactName: string;
  retentionDays: number;
}

/** Parses a whole number in [min, max]; `raw` empty means the default; `name` labels errors. */
export function intInput(name: string, raw: string, def: number, min: number, max: number): number {
  const s = raw.trim();
  if (s === '') return def;
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got '${raw}'`);
  }
  return n;
}

function boolInput(name: string, raw: string, def: boolean): boolean {
  const s = raw.trim().toLowerCase();
  if (s === '') return def;
  if (s === 'true') return true;
  if (s === 'false') return false;
  throw new Error(`input ${name} must be true or false, got '${raw}'`);
}

/** One glob per line; blank lines and `#` comments are dropped. */
function listInput(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/**
 * Reads and validates the action inputs; `get` returns '' for an unset input (as
 * `core.getInput` does). Throws with the input name on a bad value.
 */
export function parseInputs(get: (name: string) => string): ActionInputs {
  const mode = get('mode').trim() || DEFAULTS.mode;
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new Error(`input mode must be one of ${MODES.join(', ')}, got '${mode}'`);
  }
  const max = Number.MAX_SAFE_INTEGER;
  return {
    minFiles: intInput('input min-files', get('min-files'), DEFAULTS.minFiles, 0, max),
    mode: mode as Mode,
    token: get('github-token').trim(),
    comment: boolInput('comment', get('comment'), DEFAULTS.comment),
    clusterDepth: intInput(
      'input cluster-depth',
      get('cluster-depth'),
      DEFAULTS.clusterDepth,
      1,
      100,
    ),
    collapseThreshold: intInput(
      'input collapse-threshold',
      get('collapse-threshold'),
      DEFAULTS.collapseThreshold,
      0,
      max,
    ),
    scanRepo: boolInput('scan-repo', get('scan-repo'), DEFAULTS.scanRepo),
    maxPatchBytes: intInput(
      'input max-patch-bytes',
      get('max-patch-bytes'),
      DEFAULTS.maxPatchBytes,
      1,
      max,
    ),
    include: listInput(get('include')),
    exclude: listInput(get('exclude')),
    artifactName: get('artifact-name').trim() || DEFAULTS.artifactName,
    retentionDays: intInput(
      'input artifact-retention-days',
      get('artifact-retention-days'),
      DEFAULTS.retentionDays,
      1,
      90,
    ),
  };
}
