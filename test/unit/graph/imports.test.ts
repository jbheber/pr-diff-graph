import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { collectDiff } from '../../../src/diff/collect.js';
import { BlobReader } from '../../../src/diff/git.js';
import { collectImports } from '../../../src/graph/imports.js';
import { createRegistry, type ParserRegistry } from '../../../src/parsers/registry.js';
import { grammarDir, initTreeSitter } from '../../../src/parsers/treesitter.js';
import { buildRepoIndex } from '../../../src/repo/index.js';
import { makeRepo, type FileMap, type Fixture } from '../../helpers/gitfixture.js';
import { recordingLogger } from '../repo/helpers.js';

let registry: ParserRegistry;
let fixture: Fixture | undefined;
let reader: BlobReader | undefined;

beforeAll(async () => {
  registry = createRegistry(await initTreeSitter(grammarDir()), recordingLogger());
});

afterEach(async () => {
  reader?.close();
  await fixture?.cleanup();
  fixture = reader = undefined;
});

async function importsOf(base: FileMap, head: FileMap, scanRepo = false) {
  fixture = await makeRepo([base, head]);
  const [b, h] = [fixture.shas[0]!, fixture.shas[1]!];
  reader = new BlobReader(fixture.dir);
  const log = recordingLogger();
  const [headIndex, baseIndex] = await Promise.all([
    buildRepoIndex(fixture.dir, h, reader, log),
    buildRepoIndex(fixture.dir, b, reader, log),
  ]);
  const files = await collectDiff(fixture.dir, b, h, { maxPatchBytes: 1000 });
  const imports = await collectImports({
    files,
    reader,
    registry,
    headIndex,
    baseIndex,
    scanRepo,
    log,
  });
  return { imports, log };
}

describe('collectImports', () => {
  it("files over MAX_PARSE_BYTES are not parsed: 'file too large to parse'", async () => {
    const big = "import './a';\n" + 'var x = 1;\n'.repeat(110_000); // ~1.1 MB
    const { imports, log } = await importsOf({ 'a.js': '' }, { 'big.js': big });
    expect(imports.get('big.js')).toEqual({
      language: 'typescript',
      parseError: 'file too large to parse',
      imports: [],
    });
    expect(log.warnings.some((w) => w.includes('big.js'))).toBe(true);
  });

  it('a syntax error becomes a parseError, never a throw', async () => {
    const { imports } = await importsOf({}, { 'bad.ts': 'export const = ;;; {{{' });
    expect(imports.get('bad.ts')?.parseError).toMatch(/syntax error/);
  });

  it('an import missing at head is re-resolved at the merge base', async () => {
    const { imports } = await importsOf(
      { 'src/a.ts': "import './gone';\n", 'src/gone.ts': 'export {};\n' },
      { 'src/a.ts': "import './gone';\nimport './never';\n", 'src/gone.ts': null },
    );
    expect(imports.get('src/a.ts')?.imports).toEqual([
      {
        imp: { specifier: './gone', kind: 'static', line: 1 },
        res: { kind: 'unresolved', reason: 'not found' },
        baseRes: { kind: 'file', paths: ['src/gone.ts'] },
      },
      {
        imp: { specifier: './never', kind: 'static', line: 2 },
        res: { kind: 'unresolved', reason: 'not found' },
        baseRes: { kind: 'unresolved', reason: 'not found' },
      },
    ]);
    // the deleted file itself is parsed at the merge base
    expect(imports.get('src/gone.ts')).toEqual({
      language: 'typescript',
      parseError: null,
      imports: [],
    });
  });

  it('adds language-only entries for unchanged files a changed file imports', async () => {
    const { imports } = await importsOf(
      { 'a.py': 'import os\n', 'lib/u.py': 'x = 1\n' },
      { 'a.py': 'import os\nfrom lib import u\n' },
    );
    expect(imports.get('lib/u.py')).toEqual({ language: 'python', parseError: null, imports: [] });
  });

  it('scan-repo keeps only unchanged files that import a changed file', async () => {
    const { imports } = await importsOf(
      {
        'a.ts': '',
        'x.ts': "import './a';\nimport './y';\n",
        'y.ts': "import './z';\n",
        'z.ts': '',
      },
      { 'a.ts': 'export {};\n' },
      true,
    );
    expect([...imports.keys()].sort()).toEqual(['a.ts', 'x.ts']);
    expect(imports.get('x.ts')?.imports.map((e) => e.imp.specifier)).toEqual(['./a']);
  });
});
