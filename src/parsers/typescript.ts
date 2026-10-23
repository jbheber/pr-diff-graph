import { Query, type Language, type Node } from 'web-tree-sitter';
import type { Logger } from '../log.js';
import { regexImports } from './regex-fallback.js';
import { withTree, type GrammarName, type TreeSitterRuntime } from './treesitter.js';
import { ParseError, type LanguageParser, type RawImport } from './types.js';

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

const QUERY = `
(import_statement source: (string) @import)
(import_require_clause source: (string) @require)
(export_statement source: (string) @reexport)
(call_expression function: (import) arguments: (arguments . (string) @dynamic .))
(call_expression
  function: (identifier) @fn
  arguments: (arguments . (string) @require .)
  (#eq? @fn "require"))
(comment) @comment
`;

const REFERENCE = /^\/\/\/\s*<reference\s+path\s*=\s*(['"])([^'"]+)\1/;

/** `.ts/.mts/.cts` use the typescript grammar; everything else (JSX is common in `.js`) tsx. */
function grammarFor(path: string): GrammarName {
  return /\.[mc]?ts$/i.test(path) ? 'typescript' : 'tsx';
}

const unquote = (n: Node) => n.text.slice(1, -1);

function isTypeOnly(importStatement: Node): boolean {
  return importStatement.children.some((c) => c?.type === 'type');
}

function extract(language: Language, query: Query, source: string, path: string): RawImport[] {
  return withTree(language, source, (tree) => {
    const imports: { index: number; imp: RawImport }[] = [];
    const add = (node: Node, specifier: string, kind: RawImport['kind'], at: Node) => {
      if (specifier) {
        imports.push({
          index: node.startIndex,
          imp: { specifier, kind, line: at.startPosition.row + 1 },
        });
      }
    };
    for (const { name, node } of query.captures(tree.rootNode)) {
      const parent = node.parent;
      switch (name) {
        case 'import':
          if (parent) add(node, unquote(node), isTypeOnly(parent) ? 'type-only' : 'static', parent);
          break;
        case 'reexport':
          if (parent) add(node, unquote(node), 'reexport', parent);
          break;
        case 'dynamic':
        case 'require':
          add(node, unquote(node), name, node);
          break;
        case 'comment': {
          const m = REFERENCE.exec(node.text);
          if (m) add(node, m[2]!, 'reference', node);
          break;
        }
      }
    }
    if (imports.length === 0 && tree.rootNode.hasError) {
      throw new ParseError(`syntax error in ${path}`);
    }
    return imports.sort((a, b) => a.index - b.index).map((i) => i.imp);
  });
}

export function typescriptParser(rt: TreeSitterRuntime, log: Logger): LanguageParser {
  const queries = new Map<GrammarName, Query>();
  for (const name of ['typescript', 'tsx'] as const) {
    const language = rt.language(name);
    if (language) queries.set(name, new Query(language, QUERY));
  }
  let warned = false;

  return {
    id: 'typescript',
    extensions: EXTENSIONS,
    parse(source, path) {
      const grammar = grammarFor(path);
      const language = rt.language(grammar);
      const query = queries.get(grammar);
      if (!language || !query) {
        if (!warned) {
          warned = true;
          log.warn(
            `tree-sitter grammar '${grammar}' unavailable: TS/JS imports are read with the lower-fidelity regex fallback`,
          );
        }
        return regexImports('typescript', source);
      }
      return extract(language, query, source, path);
    },
    resolve() {
      return { kind: 'unresolved', reason: 'not implemented' };
    },
  };
}
