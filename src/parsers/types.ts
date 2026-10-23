import type { RepoIndex } from '../repo/index.js';

/** Files larger than this are not parsed (the caller marks the node 'file too large to parse'). */
export const MAX_PARSE_BYTES = 1_000_000;

export interface RawImport {
  specifier: string;
  kind: 'static' | 'dynamic' | 'require' | 'type-only' | 'reexport' | 'reference';
  /** 1-based line of the import statement. */
  line: number;
  /** Imported names, for Python `from X import a, b`. */
  names?: string[];
}

export type Resolution =
  /** One path for most languages; every file of the package directory for Go. */
  | { kind: 'file'; paths: string[] }
  | { kind: 'external'; name: string }
  | { kind: 'unresolved'; reason: string };

export interface LanguageParser {
  id: string;
  /** Lower-case, with the leading dot. */
  extensions: string[];
  /** Throws ParseError when the source cannot be read at all. */
  parse(source: string, path: string): RawImport[];
  resolve(imp: RawImport, from: string, repo: RepoIndex): Resolution;
}

export class ParseError extends Error {
  override name = 'ParseError';
}
