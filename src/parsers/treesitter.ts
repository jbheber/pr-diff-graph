import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, Query, type Tree } from 'web-tree-sitter';
import { consoleLogger, type Logger } from '../log.js';

export type GrammarName = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go';

const GRAMMARS: readonly GrammarName[] = ['typescript', 'tsx', 'javascript', 'python', 'go'];
const RUNTIME_WASM = 'tree-sitter.wasm';

export interface TreeSitterRuntime {
  /** The loaded grammar, or null when it failed to load (a warning was logged). */
  language(name: GrammarName): Language | null;
}

/**
 * Directory holding tree-sitter.wasm and the grammar WASMs: `dist/grammars` from the action
 * bundle (`dist/index.js`) and the CLI bundle (`dist/cli/index.js`), `<repo>/grammars` when
 * running from source.
 */
export function grammarDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'grammars'),
    join(here, '..', 'grammars'),
    join(here, '..', '..', 'grammars'),
  ];
  return candidates.find((d) => existsSync(join(d, RUNTIME_WASM))) ?? candidates[0]!;
}

let runtimeInit: Promise<void> | null = null;

/** Loads the runtime and every grammar from `dir` (file reads only, no fetch). Never throws. */
export async function initTreeSitter(
  dir: string,
  log: Logger = consoleLogger,
): Promise<TreeSitterRuntime> {
  const languages = new Map<GrammarName, Language>();
  try {
    if (!runtimeInit) {
      const wasmBinary = await readFile(join(dir, RUNTIME_WASM));
      runtimeInit = Parser.init({ wasmBinary });
    }
    await runtimeInit;
  } catch (e) {
    runtimeInit = null;
    log.warn(`tree-sitter runtime failed to load from ${dir}: ${(e as Error).message}`);
    return { language: () => null };
  }
  await Promise.all(
    GRAMMARS.map(async (name) => {
      try {
        const bytes = await readFile(join(dir, `tree-sitter-${name}.wasm`));
        languages.set(name, await Language.load(bytes));
      } catch (e) {
        log.warn(`tree-sitter grammar '${name}' failed to load: ${(e as Error).message}`);
      }
    }),
  );
  return { language: (name) => languages.get(name) ?? null };
}

/**
 * Compiles `source` for `language`; on failure warns and returns null so the caller falls
 * back to the regex extractor instead of failing the run.
 */
export function compileQuery(
  language: Language | null,
  source: string,
  grammar: GrammarName,
  log: Logger,
): Query | null {
  if (!language) return null;
  try {
    return new Query(language, source);
  } catch (e) {
    log.warn(`tree-sitter query for '${grammar}' failed to compile: ${(e as Error).message}`);
    return null;
  }
}

const parsers = new WeakMap<Language, Parser>();

/** Parses `source` with `language`, hands the tree to `fn`, and frees the tree afterwards. */
export function withTree<T>(language: Language, source: string, fn: (tree: Tree) => T): T {
  let parser = parsers.get(language);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(language, parser);
  }
  const tree = parser.parse(source);
  if (!tree) throw new Error('tree-sitter returned no tree');
  try {
    return fn(tree);
  } finally {
    tree.delete();
  }
}
