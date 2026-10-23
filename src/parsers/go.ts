import { type Query, type Language } from 'web-tree-sitter';
import type { Logger } from '../log.js';
import { resolveGoImport } from './go-resolve.js';
import { regexImports } from './regex-fallback.js';
import { compileQuery, withTree, type TreeSitterRuntime } from './treesitter.js';
import { ParseError, type LanguageParser, type RawImport } from './types.js';

const QUERY = `(import_spec path: (_) @path)`;

function extract(language: Language, query: Query, source: string, path: string): RawImport[] {
  return withTree(language, source, (tree) => {
    const imports: RawImport[] = [];
    for (const { node } of query.captures(tree.rootNode)) {
      const specifier = node.text.slice(1, -1);
      if (specifier) {
        imports.push({ specifier, kind: 'static', line: node.startPosition.row + 1 });
      }
    }
    if (imports.length === 0 && tree.rootNode.hasError) {
      throw new ParseError(`syntax error in ${path}`);
    }
    return imports;
  });
}

export function goParser(rt: TreeSitterRuntime, log: Logger): LanguageParser {
  const language = rt.language('go');
  const query = compileQuery(language, QUERY, 'go', log);
  let warned = false;

  return {
    id: 'go',
    extensions: ['.go'],
    parse(source, path) {
      if (!language || !query) {
        if (!warned) {
          warned = true;
          log.warn(
            "tree-sitter grammar 'go' unavailable: Go imports are read with the lower-fidelity regex fallback",
          );
        }
        return regexImports('go', source);
      }
      return extract(language, query, source, path);
    },
    resolve: resolveGoImport,
  };
}
