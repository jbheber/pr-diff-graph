import type { Logger } from '../log.js';
import { baseOf } from '../repo/paths.js';
import { goParser } from './go.js';
import { pythonParser } from './python.js';
import type { TreeSitterRuntime } from './treesitter.js';
import type { LanguageParser } from './types.js';
import { typescriptParser } from './typescript.js';

export interface ParserRegistry {
  parsers: LanguageParser[];
  /** The parser for `path`'s extension, or null (the file becomes a node without edges). */
  forPath(path: string): LanguageParser | null;
}

export function createRegistry(rt: TreeSitterRuntime, log: Logger): ParserRegistry {
  const parsers = [typescriptParser(rt, log), pythonParser(rt, log), goParser(rt, log)];
  const byExt = new Map<string, LanguageParser>();
  for (const p of parsers) for (const ext of p.extensions) byExt.set(ext, p);

  return {
    parsers,
    forPath(path) {
      const base = baseOf(path);
      const dot = base.lastIndexOf('.');
      if (dot <= 0) return null;
      return byExt.get(base.slice(dot).toLowerCase()) ?? null;
    },
  };
}
