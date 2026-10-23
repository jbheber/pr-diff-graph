import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_BUFFER = 512 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | string | null,
  ) {
    super(`git ${args.join(' ')} failed (${String(code)}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

/** Runs a git command in `repo` and resolves with its stdout (utf8). */
export function git(repo: string, args: string[], opts: { input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd: repo, encoding: 'utf8', maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code ?? null;
          reject(new GitError(args, stderr || err.message, code));
        } else {
          resolve(stdout);
        }
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

interface Pending {
  resolve(content: Buffer | null): void;
  reject(err: Error): void;
}

/** Reads blobs by `<sha>:<path>` through one long-lived `git cat-file --batch` process. */
export class BlobReader {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private readonly queue: Pending[] = [];
  private failure: Error | null = null;

  constructor(private readonly repo: string) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const proc = spawn('git', ['-c', 'core.quotepath=off', 'cat-file', '--batch'], {
      cwd: this.repo,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.stdout.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
    const fail = (err: Error) => {
      this.failure ??= err;
      for (const p of this.queue.splice(0)) p.reject(this.failure);
    };
    proc.on('error', fail);
    proc.stdin.on('error', fail);
    proc.on('close', (code) => {
      if (this.queue.length > 0) fail(new GitError(['cat-file', '--batch'], stderr, code));
    });
    this.proc = proc;
    return proc;
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      const header = this.buf.subarray(0, nl).toString('utf8');
      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
        this.buf = this.buf.subarray(nl + 1);
        this.queue.shift()!.resolve(null);
        continue;
      }
      const parts = header.split(' ');
      const size = Number(parts[parts.length - 1]);
      if (parts.length < 3 || !Number.isInteger(size)) {
        this.failure = new Error(`unexpected cat-file output: ${header}`);
        for (const p of this.queue.splice(0)) p.reject(this.failure);
        return;
      }
      if (this.buf.length < nl + 1 + size + 1) return;
      const content = Buffer.from(this.buf.subarray(nl + 1, nl + 1 + size));
      this.buf = this.buf.subarray(nl + 1 + size + 1);
      this.queue.shift()!.resolve(content);
    }
  }

  /** Content of `path` at commit/tree `sha`, or `null` when it does not exist there. */
  read(sha: string, path: string): Promise<Buffer | null> {
    if (this.failure) return Promise.reject(this.failure);
    // The batch protocol is line-based: a newline in a path cannot be requested.
    if (path.includes('\n')) return Promise.resolve(null);
    const proc = this.start();
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      proc.stdin.write(`${sha}:${path}\n`);
    });
  }

  close(): void {
    if (!this.proc) return;
    this.proc.stdin.end();
    this.proc.kill();
    this.proc = null;
  }
}
