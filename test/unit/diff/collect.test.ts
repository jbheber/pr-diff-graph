import { afterEach, describe, expect, it } from 'vitest';
import { collectDiff } from '../../../src/diff/collect.js';
import { makeRepo, type Fixture } from '../../helpers/gitfixture.js';

let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

const OPTS = { maxPatchBytes: 200_000 };

async function diffOf(commits: Parameters<typeof makeRepo>[0], opts = OPTS) {
  fixture = await makeRepo(commits);
  const [base, head] = [fixture.shas[0]!, fixture.shas[fixture.shas.length - 1]!];
  return collectDiff(fixture.dir, base, head, opts);
}

describe('collectDiff', () => {
  it('reports added, modified, deleted and renamed files', async () => {
    const same = 'same content\n'.repeat(20);
    const files = await diffOf([
      { 'a.ts': 'x', 'b.ts': 'y', 'old.ts': same },
      { 'a.ts': 'x2', 'b.ts': null, 'old.ts': null, 'new/name.ts': same, 'c.ts': 'new file' },
    ]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(Object.fromEntries(files.map((f) => [f.path, f.status]))).toEqual({
      'a.ts': 'modified',
      'b.ts': 'deleted',
      'new/name.ts': 'renamed',
      'c.ts': 'added',
    });
    expect(byPath['new/name.ts']!.oldPath).toBe('old.ts');
    expect(byPath['new/name.ts']!.rawStatus).toBe('R');
    expect(byPath['a.ts']!.oldPath).toBeNull();
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts', 'new/name.ts']);
    expect(byPath['a.ts']!.patch).toContain('+x2');
    expect(byPath['new/name.ts']!.patch).toContain('rename from old.ts');
  });

  it('counts additions and deletions', async () => {
    const files = await diffOf([
      { 'a.ts': 'one\ntwo\nthree\nfour\n' },
      { 'a.ts': 'one\nTWO\nthree\nfour\nfive\nsix\n' },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ additions: 3, deletions: 1, binary: false });
  });

  it('marks binary files and gives them no patch', async () => {
    const files = await diffOf([
      { 'img.png': Buffer.from([0x89, 0x50, 0x00, 0x01, 0x00]) },
      { 'img.png': Buffer.from([0x89, 0x50, 0x00, 0x02, 0x00, 0x00]) },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'img.png', binary: true, patch: null });
  });

  it('keeps real paths with spaces, unicode and quotes', async () => {
    const odd = 'dir with space/ñandú "q".ts';
    const files = await diffOf([{ 'keep.ts': '1' }, { [odd]: 'export const a = 1;\n' }]);
    expect(files.map((f) => f.path)).toEqual([odd]);
    expect(files[0]!.status).toBe('added');
    expect(files[0]!.patch).toContain('+export const a = 1;');
  });

  it('keeps patches aligned with files across many paths and odd names', async () => {
    const head: Record<string, string> = {};
    for (let i = 0; i < 450; i++) {
      head[`f${String(i).padStart(3, '0')}.ts`] = `const v${i} = ${i};\n`;
    }
    head['tab\tname.ts'] = 'const tab = 1;\n';
    const files = await diffOf([{ 'seed.ts': 's' }, head]);
    expect(files).toHaveLength(451);
    for (const f of files.filter((x) => x.path.startsWith('f'))) {
      expect(f.patch).toContain(`+const v${Number(f.path.slice(1, 4))} = `);
    }
    expect(files.find((f) => f.path === 'tab\tname.ts')!.patch).toContain('+const tab = 1;');
  });

  it('truncates patches over maxPatchBytes', async () => {
    const big = 'a line of text that repeats\n'.repeat(200);
    const files = await diffOf([{ 'a.ts': 'x\n' }, { 'a.ts': big }], { maxPatchBytes: 100 });
    const f = files[0]!;
    expect(f.patchTruncated).toBe(true);
    expect(f.additions).toBe(200);
    expect(f.patch!.length).toBeLessThanOrEqual(100 + 64);
    expect(f.patch).toContain('truncated');
  });

  it('does not truncate small patches', async () => {
    const files = await diffOf([{ 'a.ts': 'x\n' }, { 'a.ts': 'y\n' }]);
    expect(files[0]!.patchTruncated).toBe(false);
  });
});
