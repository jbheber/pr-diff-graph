import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { git } from './diff/git.js';
import { consoleLogger, type Logger } from './log.js';
import { grammarDir } from './parsers/treesitter.js';
import { runPipeline } from './pipeline.js';
import { reportAssetsDir } from './report/render.js';

const USAGE = `Usage: pr-diff-graph --repo <path> --base <ref> --head <ref> [options]

Options:
  --repo <path>       git repository to analyse (default: .)
  --base <ref>        base branch or commit
  --head <ref>        head branch or commit
  --out <dir>         output directory (default: pr-diff-graph)
  --min-files <n>     skip when changed files <= n (default: 50)
  --scan-repo         parse the whole repo to find unchanged importers of changed files
  --open              open the report when done
  -h, --help          show this help`;

export interface CliArgs {
  repo: string;
  base: string;
  head: string;
  out: string;
  minFiles: number;
  scanRepo: boolean;
  open: boolean;
}

/** Parses argv (without node and script); throws with a message on bad input. */
export function parseCliArgs(argv: string[]): CliArgs | 'help' {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      repo: { type: 'string', default: '.' },
      base: { type: 'string' },
      head: { type: 'string' },
      out: { type: 'string', default: 'pr-diff-graph' },
      'min-files': { type: 'string', default: '50' },
      'scan-repo': { type: 'boolean', default: false },
      open: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return 'help';
  if (!values.base || !values.head) throw new Error('--base and --head are required');
  const minFiles = Number(values['min-files']);
  if (!Number.isInteger(minFiles) || minFiles < 0) {
    throw new Error(`--min-files must be a non-negative integer, got ${values['min-files']}`);
  }
  return {
    repo: values.repo,
    base: values.base,
    head: values.head,
    out: values.out,
    minFiles,
    scanRepo: values['scan-repo'],
    open: values.open,
  };
}

async function revParse(repo: string, ref: string): Promise<string> {
  try {
    return (
      await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
    ).trim();
  } catch {
    throw new Error(`cannot resolve '${ref}' to a commit in ${repo}`);
  }
}

/**
 * Opens `path` with the OS default handler, detached; never throws (warns instead). On Windows
 * the empty argument is start's window title, which Node quotes as `""`.
 */
export function openFile(path: string, log: Logger): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', path]]
      : process.platform === 'darwin'
        ? ['open', [path]]
        : ['xdg-open', [path]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => log.warn(`could not open ${path}: ${e.message}`));
    child.unref();
  } catch (e) {
    log.warn(`could not open ${path}: ${(e as Error).message}`);
  }
}

/** Runs the CLI; resolves with the exit code (0 on success or skip, 1 on error). */
export async function main(argv: string[], log: Logger = consoleLogger): Promise<number> {
  let args: CliArgs | 'help';
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    console.error(`error: ${(e as Error).message}\n\n${USAGE}`);
    return 1;
  }
  if (args === 'help') {
    console.log(USAGE);
    return 0;
  }

  try {
    const repo = resolve(args.repo);
    const [base, head] = await Promise.all([revParse(repo, args.base), revParse(repo, args.head)]);
    const result = await runPipeline({
      repo,
      base,
      head,
      outDir: resolve(args.out),
      minFiles: args.minFiles,
      include: [],
      exclude: [],
      clusterDepth: 2,
      collapseThreshold: 150,
      scanRepo: args.scanRepo,
      maxPatchBytes: 200_000,
      prNumber: null,
      repoSlug: null,
      log,
      grammarDir: grammarDir(),
      assetsDir: reportAssetsDir(),
    });
    if (result.skipped) return 0;
    for (const p of [result.reportPath, result.graphPath, result.summaryPath]) {
      if (p) console.log(p);
    }
    if (args.open) {
      if (result.reportPath) openFile(result.reportPath, log);
      else log.warn('--open: no report was written');
    }
    return 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
