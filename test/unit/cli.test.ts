import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main, openCommand, parseCliArgs } from '../../src/cli.js';
import { silentLogger } from '../../src/log.js';
import { makeMonorepo, type MonorepoFixture } from '../e2e/fixture.js';

describe('parseCliArgs', () => {
  it('applies defaults', () => {
    expect(parseCliArgs(['--base', 'main', '--head', 'feat'])).toEqual({
      repo: '.',
      base: 'main',
      head: 'feat',
      out: 'pr-diff-graph',
      minFiles: 50,
      scanRepo: false,
      open: false,
    });
  });

  it('rejects missing refs, bad numbers and unknown flags', () => {
    expect(() => parseCliArgs(['--base', 'x'])).toThrow(/required/);
    expect(() => parseCliArgs(['--base', 'x', '--head', 'y', '--min-files', '-1'])).toThrow(
      /min-files/,
    );
    expect(() => parseCliArgs(['--base', 'x', '--head', 'y', '--nope'])).toThrow();
    expect(parseCliArgs(['-h'])).toBe('help');
  });
});

describe('openCommand', () => {
  it('passes the path as one argument and never through a shell on Windows', () => {
    const path = String.raw`C:\out\a&b ^%x%\report.html`;
    expect(openCommand(path, 'win32')).toEqual(['explorer.exe', [path]]);
    expect(openCommand('/o/r.html', 'darwin')).toEqual(['open', ['/o/r.html']]);
    expect(openCommand('/o/r.html', 'linux')).toEqual(['xdg-open', ['/o/r.html']]);
  });
});

describe('main', () => {
  let fx: MonorepoFixture;
  let out: string;

  beforeAll(async () => {
    fx = await makeMonorepo();
    out = await mkdtemp(join(tmpdir(), 'pdg-cli-'));
  });

  afterAll(async () => {
    await fx?.cleanup();
    if (out) await rm(out, { recursive: true, force: true });
  });

  it('resolves refs, runs the pipeline and prints the output paths', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(
        ['--repo', fx.dir, '--base', 'base', '--head', 'main', '--out', out, '--min-files', '0'],
        silentLogger,
      );
      expect(code).toBe(0);
      expect(log.mock.calls.map((c) => c[0])).toEqual([
        join(out, 'report.html'),
        join(out, 'graph.json'),
        join(out, 'summary.json'),
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('exits 0 on skip and 1 on an unknown ref', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const args = ['--repo', fx.dir, '--base', 'base', '--out', join(out, 'x')];
      expect(await main([...args, '--head', 'main'], silentLogger)).toBe(0);
      expect(await main([...args, '--head', 'no-such-ref'], silentLogger)).toBe(1);
      expect(err.mock.calls[0]?.[0]).toContain("cannot resolve 'no-such-ref'");
    } finally {
      err.mockRestore();
    }
  });
});
