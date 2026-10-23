import { describe, expect, it } from 'vitest';
import type { ChangedFile, ChangeStatus } from '../../../src/diff/collect.js';
import { buildGraph, type BuildGraphArgs } from '../../../src/graph/build.js';
import type { FileImports, ImportEntry } from '../../../src/graph/types.js';
import type { RawImport, Resolution } from '../../../src/parsers/types.js';
import type { RepoIndex } from '../../../src/repo/index.js';

const index = { packageOf: () => null, has: () => true } as unknown as RepoIndex;

function changed(
  path: string,
  status: ChangeStatus = 'modified',
  extra: Partial<ChangedFile> = {},
): ChangedFile {
  return {
    path,
    oldPath: null,
    status,
    rawStatus: status.charAt(0).toUpperCase(),
    additions: 1,
    deletions: 1,
    binary: false,
    patch: `diff --git a/${path} b/${path}\n`,
    patchTruncated: false,
    ...extra,
  };
}

const file = (...paths: string[]): Resolution => ({ kind: 'file', paths });
const external = (name: string): Resolution => ({ kind: 'external', name });
const notFound: Resolution = { kind: 'unresolved', reason: 'not found' };

function imp(specifier: string, line = 1, kind: RawImport['kind'] = 'static'): RawImport {
  return { specifier, kind, line };
}

function ts(...imports: ImportEntry[]): FileImports {
  return { language: 'typescript', parseError: null, imports };
}

function build(
  files: ChangedFile[],
  imports: Record<string, FileImports>,
  extra: Partial<BuildGraphArgs> = {},
) {
  return buildGraph({
    pr: { number: 7, base: 'b', head: 'h', mergeBase: 'm', repo: 'o/r' },
    files,
    imports: new Map(Object.entries(imports)),
    headIndex: index,
    baseIndex: index,
    clusterDepth: 2,
    rawFiles: files.length + 1,
    ...extra,
  });
}

describe('buildGraph', () => {
  it('changed→changed edges are marked', () => {
    const { graph, diffs } = build([changed('src/a.ts'), changed('src/b.ts', 'added')], {
      'src/a.ts': ts({ imp: imp('./b'), res: file('src/b.ts') }),
      'src/b.ts': ts(),
    });
    expect(graph.version).toBe(1);
    expect(graph.edges).toEqual([
      {
        from: 'src/a.ts',
        to: 'src/b.ts',
        kind: 'changed-changed',
        importKinds: ['static'],
        inCycle: false,
      },
    ]);
    expect(graph.nodes.map((n) => [n.id, n.changed, n.status, n.cluster, n.diffRef])).toEqual([
      ['src/a.ts', true, 'modified', 'c:src', 0],
      ['src/b.ts', true, 'added', 'c:src', 1],
    ]);
    expect(diffs.map((d) => d.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(graph.summary).toMatchObject({ files: 2, edges: 1, additions: 2, rawFiles: 3 });
    expect(graph.clusters).toEqual([{ id: 'c:src', label: 'src', parent: null }]);
  });

  it('node.cluster is the innermost cluster, neighbors counted', () => {
    const many = (dir: string, n: number) =>
      Array.from({ length: n }, (_, i) => changed(`${dir}/f${i}.ts`));
    const files = [...many('src/app/a', 20), ...many('src/app/b', 10)];
    // 30 changed files fit one cluster; the neighbor makes it 31, which splits it.
    const { graph } = build(files, {
      'src/app/a/f0.ts': ts({ imp: imp('../c/u'), res: file('src/app/c/u.ts') }),
    });
    const clusterOf = new Map(graph.nodes.map((n) => [n.id, n.cluster]));
    expect(clusterOf.get('src/app/a/f0.ts')).toBe('c:src/app/a');
    expect(clusterOf.get('src/app/b/f9.ts')).toBe('c:src/app/b');
    expect(clusterOf.get('src/app/c/u.ts')).toBe('c:src/app/c');
    expect(graph.clusters).toEqual([
      { id: 'c:src/app', label: 'src/app', parent: null },
      { id: 'c:src/app/a', label: 'a', parent: 'c:src/app' },
      { id: 'c:src/app/b', label: 'b', parent: 'c:src/app' },
      { id: 'c:src/app/c', label: 'c', parent: 'c:src/app' },
    ]);
  });

  it('outgoing unchanged neighbors are nodes with changed:false', () => {
    const { graph } = build([changed('src/a.ts')], {
      'src/a.ts': ts({ imp: imp('../lib/u'), res: file('lib/u.ts') }),
      'lib/u.ts': ts(),
    });
    const u = graph.nodes.find((n) => n.id === 'lib/u.ts');
    expect(u).toMatchObject({
      changed: false,
      status: 'unchanged',
      additions: 0,
      deletions: 0,
      diffRef: null,
      language: 'typescript',
      cluster: 'c:lib',
    });
    expect(graph.edges).toEqual([expect.objectContaining({ kind: 'changed-unchanged' })]);
    expect(graph.summary.files).toBe(1);
  });

  it('deleted files use base edges', () => {
    const { graph } = build(
      [
        changed('src/gone.ts', 'deleted'),
        changed('src/new.ts', 'renamed', { oldPath: 'src/old.ts' }),
      ],
      {
        // parsed at the merge base: it imported the renamed file under its old path
        'src/gone.ts': ts({ imp: imp('./old'), res: file('src/old.ts') }),
        'src/new.ts': ts(),
      },
    );
    expect(graph.edges.map((e) => [e.from, e.to, e.kind])).toEqual([
      ['src/gone.ts', 'src/new.ts', 'changed-changed'],
    ]);
    expect(graph.nodes.find((n) => n.id === 'src/new.ts')?.oldPath).toBe('src/old.ts');
  });

  it("deleted and renamed files under excluded paths still give 'target deleted'", () => {
    const { graph } = build(
      [changed('src/a.ts')],
      {
        'src/a.ts': ts(
          { imp: imp('./gone', 2), res: notFound, baseRes: file('vendor/gone.ts') },
          { imp: imp('./old', 3), res: notFound, baseRes: file('vendor/old.ts') },
        ),
      },
      {
        allChangedFiles: [
          changed('src/a.ts'),
          changed('vendor/gone.ts', 'deleted'),
          changed('vendor/new.ts', 'renamed', { oldPath: 'vendor/old.ts' }),
        ],
      },
    );
    expect(graph.unresolved.map((u) => u.reason)).toEqual(['target deleted', 'target deleted']);
  });

  it('a deleted file does not add an unchanged node for a neighbor missing at head', () => {
    const headIndex = { packageOf: () => null, has: (p: string) => p === 'src/kept.ts' };
    const { graph } = build(
      [changed('src/gone.ts', 'deleted')],
      {
        'src/gone.ts': ts(
          { imp: imp('./kept'), res: file('src/kept.ts') },
          { imp: imp('./other'), res: file('src/other.ts') },
        ),
      },
      { headIndex: headIndex as unknown as RepoIndex },
    );
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['src/gone.ts', 'src/kept.ts']);
    expect(graph.edges.map((e) => e.to)).toEqual(['src/kept.ts']);
  });

  it("import of a deleted path becomes unresolved with reason 'target deleted'", () => {
    const { graph } = build(
      [
        changed('src/a.ts'),
        changed('src/gone.ts', 'deleted'),
        changed('src/new.ts', 'renamed', { oldPath: 'src/old.ts' }),
      ],
      {
        'src/a.ts': ts(
          { imp: imp('./old', 3), res: notFound, baseRes: file('src/old.ts') },
          { imp: imp('./gone', 2), res: notFound, baseRes: file('src/gone.ts') },
          { imp: imp('./never', 4), res: notFound, baseRes: notFound },
          { imp: imp('./kept', 5), res: notFound, baseRes: file('src/kept.ts') },
        ),
        'src/gone.ts': ts({ imp: imp('./missing', 9), res: notFound }),
        'src/new.ts': ts(),
      },
    );
    expect(graph.unresolved).toEqual([
      { from: 'src/a.ts', specifier: './gone', line: 2, reason: 'target deleted' },
      { from: 'src/a.ts', specifier: './old', line: 3, reason: 'target deleted' },
      { from: 'src/a.ts', specifier: './never', line: 4, reason: 'not found' },
      { from: 'src/a.ts', specifier: './kept', line: 5, reason: 'not found' },
      { from: 'src/gone.ts', specifier: './missing', line: 9, reason: 'not found' },
    ]);
    expect(graph.summary.unresolved).toBe(5);
    expect(graph.edges).toEqual([]);
  });

  it('parse error yields node with parseError and no edges', () => {
    const { graph } = build([changed('src/bad.ts'), changed('src/b.ts')], {
      'src/bad.ts': {
        language: 'typescript',
        parseError: 'syntax error in src/bad.ts',
        imports: [{ imp: imp('./b'), res: file('src/b.ts') }],
      },
    });
    expect(graph.nodes.find((n) => n.id === 'src/bad.ts')?.parseError).toBe(
      'syntax error in src/bad.ts',
    );
    expect(graph.edges).toEqual([]);
    expect(graph.summary.parseErrors).toBe(1);
  });

  it('Go package import makes one edge per file', () => {
    const { graph } = build([changed('cmd/main.go')], {
      'cmd/main.go': {
        language: 'go',
        parseError: null,
        imports: [{ imp: imp('example.com/m/db'), res: file('db/a.go', 'db/b.go') }],
      },
    });
    expect(graph.edges.map((e) => [e.from, e.to])).toEqual([
      ['cmd/main.go', 'db/a.go'],
      ['cmd/main.go', 'db/b.go'],
    ]);
    expect(graph.nodes.filter((n) => !n.changed).map((n) => n.id)).toEqual(['db/a.go', 'db/b.go']);
  });

  it('duplicate imports of the same target merge importKinds', () => {
    const { graph } = build([changed('a.ts'), changed('b.ts')], {
      'a.ts': ts(
        { imp: imp('./b', 1, 'type-only'), res: file('b.ts') },
        { imp: imp('./b', 2, 'static'), res: file('b.ts') },
        { imp: imp('./b.js', 3, 'static'), res: file('b.ts') },
        { imp: imp('./b', 4, 'dynamic'), res: file('b.ts') },
      ),
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.importKinds).toEqual(['dynamic', 'static', 'type-only']);
  });

  it('externals are counted not drawn', () => {
    const { graph } = build([changed('a.ts'), changed('b.py')], {
      'a.ts': ts(
        { imp: imp('react'), res: external('react') },
        { imp: imp('react/jsx-runtime'), res: external('react') },
        { imp: imp('lodash'), res: external('lodash') },
      ),
      'b.py': {
        language: 'python',
        parseError: null,
        imports: [{ imp: imp('os'), res: external('os') }],
      },
    });
    expect(graph.summary.externals).toBe(3);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([]);
  });

  it('edge inCycle flags', () => {
    const { graph } = build([changed('a.ts'), changed('b.ts'), changed('c.ts'), changed('d.ts')], {
      'a.ts': ts({ imp: imp('./b'), res: file('b.ts') }),
      'b.ts': ts({ imp: imp('./a'), res: file('a.ts') }, { imp: imp('./c'), res: file('c.ts') }),
      'c.ts': ts({ imp: imp('./c'), res: file('c.ts') }, { imp: imp('./u'), res: file('u.ts') }),
      'u.ts': ts(),
    });
    expect(graph.edges.map((e) => `${e.from}>${e.to}:${e.inCycle}`)).toEqual([
      'a.ts>b.ts:true',
      'b.ts>a.ts:true',
      'b.ts>c.ts:false',
      'c.ts>c.ts:true',
      'c.ts>u.ts:false',
    ]);
    expect(graph.cycles).toEqual([['a.ts', 'b.ts'], ['c.ts']]);
    expect(graph.summary.cycles).toBe(2);
    expect(graph.ranking[0]).toBe('b.ts');
  });

  it('unchanged importers found by scan-repo point at changed files only', () => {
    const { graph } = build([changed('a.ts')], {
      'a.ts': ts(),
      'x.ts': ts({ imp: imp('./a'), res: file('a.ts') }, { imp: imp('./y'), res: file('y.ts') }),
      'y.ts': ts({ imp: imp('./z'), res: file('z.ts') }),
    });
    expect(graph.edges.map((e) => [e.from, e.to, e.kind])).toEqual([
      ['x.ts', 'a.ts', 'unchanged-changed'],
    ]);
    expect(graph.nodes.map((n) => n.id)).toEqual(['a.ts', 'x.ts']);
  });

  it('binary files carry no patch in their diff entry', () => {
    const { graph, diffs } = build(
      [changed('logo.png', 'added', { binary: true, patch: null, additions: 0, deletions: 0 })],
      {},
    );
    expect(graph.summary.binary).toBe(1);
    expect(graph.nodes[0]).toMatchObject({ binary: true, language: null, diffRef: 0 });
    expect(diffs).toEqual([{ path: 'logo.png', patch: null, truncated: false, binary: true }]);
  });
});
