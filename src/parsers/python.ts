import { Query, type Language, type Node } from 'web-tree-sitter';
import type { Logger } from '../log.js';
import { resolvePythonImport } from './python-resolve.js';
import { regexImports } from './regex-fallback.js';
import { withTree, type TreeSitterRuntime } from './treesitter.js';
import { ParseError, type LanguageParser, type RawImport } from './types.js';

const EXTENSIONS = ['.py', '.pyi'];

const QUERY = `
(import_statement) @import
(import_from_statement) @from
`;

/** The module of `import a.b as c` / `from a.b import c as d`: the name before any alias. */
const moduleOf = (n: Node): string =>
  n.type === 'aliased_import' ? (n.childForFieldName('name')?.text ?? '') : n.text;

function extract(language: Language, query: Query, source: string, path: string): RawImport[] {
  return withTree(language, source, (tree) => {
    const imports: { index: number; imp: RawImport }[] = [];
    for (const { name, node } of query.captures(tree.rootNode)) {
      const line = node.startPosition.row + 1;
      if (name === 'import') {
        for (const child of node.childrenForFieldName('name')) {
          const specifier = moduleOf(child);
          if (specifier) {
            imports.push({ index: child.startIndex, imp: { specifier, kind: 'static', line } });
          }
        }
      } else {
        const specifier = node.childForFieldName('module_name')?.text.replace(/\s+/g, '') ?? '';
        if (!specifier) continue;
        const names = node.childrenForFieldName('name').map(moduleOf).filter(Boolean);
        imports.push({
          index: node.startIndex,
          imp: { specifier, kind: 'static', line, ...(names.length > 0 ? { names } : {}) },
        });
      }
    }
    if (imports.length === 0 && tree.rootNode.hasError) {
      throw new ParseError(`syntax error in ${path}`);
    }
    return imports.sort((a, b) => a.index - b.index).map((i) => i.imp);
  });
}

export function pythonParser(rt: TreeSitterRuntime, log: Logger): LanguageParser {
  const language = rt.language('python');
  const query = language ? new Query(language, QUERY) : null;
  let warned = false;

  return {
    id: 'python',
    extensions: EXTENSIONS,
    parse(source, path) {
      if (!language || !query) {
        if (!warned) {
          warned = true;
          log.warn(
            "tree-sitter grammar 'python' unavailable: Python imports are read with the lower-fidelity regex fallback",
          );
        }
        return regexImports('python', source);
      }
      return extract(language, query, source, path);
    },
    resolve: resolvePythonImport,
  };
}
