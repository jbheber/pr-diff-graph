import { execFile } from 'node:child_process';
import { makeRepo, type FileMap } from '../helpers/gitfixture.js';

export interface MonorepoFixture {
  dir: string;
  /** Tip of the base branch: a commit made after the PR branched off. */
  base: string;
  head: string;
  /** Where the PR branched off; what the diff is taken against. */
  mergeBase: string;
  cleanup(): Promise<void>;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/** A 1×1 PNG: real binary content (NUL bytes) so git reports it as binary. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

/** Long enough that a small edit still counts as a rename. */
function body(lines: number, prefix: string, comment: string): string {
  return Array.from({ length: lines }, (_, i) => `${comment} ${prefix} line ${i + 1}`).join('\n');
}

const BASE: FileMap = {
  'package.json': json({ name: 'acme', private: true, workspaces: ['packages/*'] }),
  'package-lock.json': json({ name: 'acme', lockfileVersion: 3, packages: {} }),
  'README.md': '# acme\n',

  // packages/core: TS, entry point through `exports` with a `source` condition
  'packages/core/package.json': json({
    name: '@acme/core',
    exports: { '.': { source: './src/index.ts', default: './dist/index.js' } },
  }),
  'packages/core/src/index.ts': "export * from './math';\nexport * from './strings';\n",
  'packages/core/src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
  'packages/core/src/strings.ts': 'export const upper = (s: string) => s.toUpperCase();\n',
  'packages/core/src/legacy.ts': 'export const old = 1;\n',
  'packages/core/src/format.ts': `import { upper } from './strings';\n${body(12, 'format', '//')}\nexport const shout = (s: string) => upper(s) + '!';\n`,

  // packages/web: TSX, `@/*` alias, imports @acme/core
  'packages/web/package.json': json({
    name: '@acme/web',
    dependencies: { '@acme/core': '*', react: '^19.0.0' },
  }),
  'packages/web/tsconfig.json': json({
    compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] }, jsx: 'react-jsx' },
  }),
  'packages/web/src/App.tsx':
    "import { add } from '@acme/core';\nimport { Button } from '@/components/Button';\n\nexport const App = () => <Button label={String(add(1, 2))} />;\n",
  'packages/web/src/components/Button.tsx':
    "import React from 'react';\n\nexport const Button = (p: { label: string }) => <button>{p.label}</button>;\nexport default React;\n",
  'packages/web/src/deprecated.tsx':
    'import { Button } from \'@/components/Button\';\n\nexport const Old = () => <Button label="old" />;\n',
  'packages/web/src/uses-legacy.ts':
    "import { upper } from '@acme/core';\n\nexport const u = upper('a');\n",

  // services/py: Python, src/ layout, relative imports
  'services/py/pyproject.toml': '[project]\nname = "svc"\n',
  'services/py/src/app/__init__.py': '',
  'services/py/src/app/db.py':
    'import sqlite3\n\n\ndef connect():\n    return sqlite3.connect(":memory:")\n',
  'services/py/src/app/config.py': `${body(12, 'config', '#')}\nDEBUG = False\n`,
  'services/py/src/app/main.py':
    'import os\nfrom .db import connect\nfrom . import config\n\n\ndef run():\n    return connect(), os.name\n',
  'services/py/src/app/old_helpers.py':
    'from .db import connect\n\n\ndef helper():\n    return connect()\n',

  // services/go: go.mod example.com/svc, packages main and store
  'services/go/go.mod': 'module example.com/svc\n\ngo 1.22\n',
  'services/go/main.go':
    'package main\n\nimport (\n\t"fmt"\n\n\t"example.com/svc/store"\n)\n\nfunc main() {\n\tfmt.Println(store.Get())\n}\n',
  'services/go/store/store.go': 'package store\n\nfunc Get() int {\n\treturn 1\n}\n',
  'services/go/store/cache.go': 'package store\n\nvar cache = map[string]int{}\n',
  'services/go/store/old.go': 'package store\n\nfunc Old() int {\n\treturn 0\n}\n',
  'services/go/store/legacy_names.go': `package store\n\n${body(12, 'names', '//')}\nconst Name = "store"\n`,
};

const HEAD: FileMap = {
  'package-lock.json': json({ name: 'acme', lockfileVersion: 3, packages: { '': {} } }),

  // TS: modify, delete, rename, add (cycle, syntax error, .vue, binary, deleted-import)
  'packages/core/src/math.ts':
    'export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n',
  'packages/core/src/legacy.ts': null,
  'packages/core/src/format.ts': null,
  'packages/core/src/fmt/format.ts': `import { upper } from '../strings';\n${body(12, 'format', '//')}\nexport const shout = (s: string) => upper(s) + '!';\n`,
  'packages/web/src/App.tsx':
    "import { add, sub } from '@acme/core';\nimport { Button } from '@/components/Button';\nimport { a } from './cycle/a';\n\nexport const App = () => <Button label={String(add(1, sub(3, a())))} />;\n",
  'packages/web/src/deprecated.tsx': null,
  'packages/web/src/uses-legacy.ts':
    "import { upper } from '@acme/core';\nimport { old } from '../../core/src/legacy';\n\nexport const u = upper('a') + old;\n",
  'packages/web/src/cycle/a.ts':
    "import { b } from './b';\n\nexport const a = (): number => b() + 1;\n",
  'packages/web/src/cycle/b.ts':
    "import { c } from './c';\n\nexport const b = (): number => c() + 1;\n",
  'packages/web/src/cycle/c.ts':
    "import type { a } from './a';\n\nexport const c = (): number => 0;\nexport type A = typeof a;\n",
  'packages/web/src/broken.ts': 'export const = ;;; {{{\n',
  'packages/web/src/Header.vue': '<template><h1>acme</h1></template>\n',
  'packages/web/public/logo.png': PNG,

  // Python: modify, delete, rename, add
  'services/py/src/app/main.py':
    'import os\nfrom .db import connect\nfrom .settings import DEBUG\n\n\ndef run():\n    return connect(), os.name, DEBUG\n',
  'services/py/src/app/old_helpers.py': null,
  'services/py/src/app/config.py': null,
  'services/py/src/app/settings.py': `${body(12, 'config', '#')}\nDEBUG = True\n`,
  'services/py/src/app/api.py':
    'from .main import run\nfrom .settings import DEBUG\n\n\ndef handler():\n    return run() if DEBUG else None\n',

  // Go: modify, delete, rename, add (a second package)
  'services/go/main.go':
    'package main\n\nimport (\n\t"fmt"\n\n\t"example.com/svc/store"\n\t"example.com/svc/util"\n)\n\nfunc main() {\n\tfmt.Println(util.Up("x"), store.Get())\n}\n',
  'services/go/store/store.go': 'package store\n\nfunc Get() int {\n\treturn 2\n}\n',
  'services/go/store/old.go': null,
  'services/go/store/legacy_names.go': null,
  'services/go/store/names.go': `package store\n\n${body(12, 'names', '//')}\nconst Name = "store/v2"\n`,
  'services/go/util/util.go':
    'package util\n\nimport "strings"\n\nfunc Up(s string) string {\n\treturn strings.ToUpper(s)\n}\n',
};

function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args.join(' ')} failed: ${stderr}`)) : resolve(stdout.trim()),
    );
  });
}

/**
 * The e2e monorepo: npm workspaces (`packages/core`, `packages/web`), a Python service and a
 * Go module. The PR branch adds, modifies, deletes and renames files in each language; the
 * base branch has moved on by one commit, so base, head and merge base are all distinct.
 */
export async function makeMonorepo(): Promise<MonorepoFixture> {
  const fx = await makeRepo([BASE, HEAD]);
  const [mergeBase, head] = [fx.shas[0]!, fx.shas[1]!];
  const tree = await git(fx.dir, ['rev-parse', `${mergeBase}^{tree}`]);
  const base = await git(fx.dir, ['commit-tree', tree, '-p', mergeBase, '-m', 'base moves on']);
  await git(fx.dir, ['update-ref', 'refs/heads/base', base]);
  return { dir: fx.dir, base, head, mergeBase, cleanup: fx.cleanup };
}
