import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type FileMap = Record<string, string | Buffer | null>;

export interface Fixture {
  dir: string;
  /** Commit SHAs, oldest first. */
  shas: string[];
  cleanup(): Promise<void>;
}

function run(dir: string, args: string[], input?: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
        else resolve(stdout.trim());
      },
    );
    child.stdin?.end(input);
  });
}

const ZERO = '0'.repeat(40);

/**
 * Builds a repository from commits. Each commit is a file map applied on top of the
 * previous one (`null` deletes). Objects are written with plumbing commands only, so
 * paths that the host filesystem cannot hold (quotes on Windows) still work and the
 * working tree is never involved.
 */
export async function makeRepo(commits: FileMap[]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'pdg-fixture-'));
  await run(dir, ['init', '-q', '-b', 'main']);
  await run(dir, ['config', 'user.name', 'Fixture']);
  await run(dir, ['config', 'user.email', 'fixture@example.com']);
  await run(dir, ['config', 'core.autocrlf', 'false']);
  // Windows git refuses paths with quotes or tabs unless NTFS protection is off.
  await run(dir, ['config', 'core.protectNTFS', 'false']);

  const blobDir = join(dir, '.git', 'pdg-blobs');
  await mkdir(blobDir, { recursive: true });

  const shas: string[] = [];
  for (const [i, files] of commits.entries()) {
    const entries = Object.entries(files);
    // One hash-object call per commit: contents go to temp files inside .git.
    const contents = entries.flatMap(([, c]) => (c === null ? [] : [c]));
    const names: string[] = [];
    for (const [n, content] of contents.entries()) {
      const file = join(blobDir, String(n));
      await writeFile(file, content);
      names.push(file);
    }
    const blobs = contents.length
      ? (await run(dir, ['hash-object', '-w', '--stdin-paths'], names.join('\n') + '\n')).split(
          '\n',
        )
      : [];

    let info = '';
    let n = 0;
    for (const [path, content] of entries) {
      info += content === null ? `0 ${ZERO}\t${path}\0` : `100644 ${blobs[n++]}\t${path}\0`;
    }
    await run(dir, ['update-index', '--add', '-z', '--index-info'], info);
    const tree = await run(dir, ['write-tree']);
    const parent = shas[shas.length - 1];
    const args = ['commit-tree', tree, '-m', `commit ${i}`];
    if (parent) args.push('-p', parent);
    const sha = await run(dir, args);
    await run(dir, ['update-ref', 'HEAD', sha]);
    shas.push(sha);
  }

  return {
    dir,
    shas,
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3 }),
  };
}
