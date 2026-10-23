import { describe, expect, it } from 'vitest';
import type { Language } from 'web-tree-sitter';
import { goParser } from '../../../src/parsers/go.js';
import { pythonParser } from '../../../src/parsers/python.js';
import type { TreeSitterRuntime } from '../../../src/parsers/treesitter.js';
import { typescriptParser } from '../../../src/parsers/typescript.js';
import { recordingLogger } from '../repo/helpers.js';

/** A grammar whose queries cannot compile (a stub, not a real Language). */
const brokenRuntime: TreeSitterRuntime = { language: () => ({}) as unknown as Language };

describe('a tree-sitter query that fails to compile', () => {
  it.each([
    ['typescript', typescriptParser, 'a.ts', "import x from './b';\n", './b'],
    ['python', pythonParser, 'a.py', 'import os\n', 'os'],
    ['go', goParser, 'a.go', 'package main\nimport "fmt"\n', 'fmt'],
  ] as const)('%s: warns and falls back to the regex extractor', (id, make, path, src, spec) => {
    const log = recordingLogger();
    const parser = make(brokenRuntime, log);
    expect(() => parser.parse(src, path)).not.toThrow();
    expect(parser.parse(src, path).map((i) => i.specifier)).toContain(spec);
    expect(log.warnings.some((w) => w.includes(id))).toBe(true);
  });
});
