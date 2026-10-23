import type { RawImport } from './types.js';

// Lower-fidelity extraction, used only when a tree-sitter grammar failed to load: it misses
// imports built in template strings and can catch some that sit in comments or strings.

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = source.indexOf('\n'); i !== -1 && i < index; i = source.indexOf('\n', i + 1)) {
    line++;
  }
  return line;
}

const TS_PATTERNS: { re: RegExp; kind: (m: RegExpExecArray) => RawImport['kind'] }[] = [
  {
    // import x from 'a' / import type {X} from 'a' / import 'a' (clause may span lines)
    re: /(?:^|[;\n])[ \t]*import(\s+type\b)?(?:\s*[\w$*{][^;'"]*?\bfrom)?\s*(['"])([^'"\n]+)\2/g,
    kind: (m) => (m[1] ? 'type-only' : 'static'),
  },
  {
    re: /(?:^|[;\n])[ \t]*export\s+(?:type\s+)?[*{][^;'"]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
    kind: () => 'reexport',
  },
  { re: /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g, kind: () => 'dynamic' },
  { re: /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g, kind: () => 'require' },
  { re: /^[ \t]*\/\/\/\s*<reference\s+path\s*=\s*(['"])([^'"\n]+)\1/gm, kind: () => 'reference' },
];

function typescriptImports(source: string): RawImport[] {
  const found: { index: number; imp: RawImport }[] = [];
  for (const { re, kind } of TS_PATTERNS) {
    for (const m of source.matchAll(re)) {
      const specifier = m[m.length - 1]!;
      // Report the line of the keyword, not of the separator the pattern consumed before it.
      const index = m.index + m[0].search(/\S/);
      found.push({ index, imp: { specifier, kind: kind(m), line: lineAt(source, index) } });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.imp);
}

const asName = (part: string) =>
  part
    .trim()
    .split(/\s+as\s+/)[0]!
    .trim();

function pythonImports(source: string): RawImport[] {
  const out: RawImport[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    const line = i + 1;
    const from = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(text);
    if (from) {
      // A parenthesised list may continue on the following lines.
      let rest = from[2]!.replace(/#.*$/, '');
      while (rest.includes('(') && !rest.includes(')') && i + 1 < lines.length) {
        rest += ' ' + lines[++i]!.replace(/#.*$/, '');
      }
      const names = rest
        .replace(/[()\\]/g, '')
        .split(',')
        .map(asName)
        .filter(Boolean);
      const wildcard = names.length === 1 && names[0] === '*';
      out.push({
        specifier: from[1]!,
        kind: 'static',
        line,
        ...(names.length > 0 && !wildcard ? { names } : {}),
      });
      continue;
    }
    const imp = /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/.exec(
      text,
    );
    if (imp) {
      for (const part of imp[1]!.split(',')) {
        out.push({ specifier: asName(part), kind: 'static', line });
      }
    }
  }
  return out;
}

function goImports(source: string): RawImport[] {
  const out: RawImport[] = [];
  const lines = source.split('\n');
  let inGroup = false;
  lines.forEach((text, i) => {
    const line = i + 1;
    if (inGroup) {
      if (/^\s*\)/.test(text)) inGroup = false;
      else {
        const m = /^\s*(?:[\w.]+\s+)?"([^"]+)"/.exec(text);
        if (m) out.push({ specifier: m[1]!, kind: 'static', line });
      }
      return;
    }
    if (/^\s*import\s*\(/.test(text)) {
      inGroup = true;
      return;
    }
    const m = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(text);
    if (m) out.push({ specifier: m[1]!, kind: 'static', line });
  });
  return out;
}

export function regexImports(
  language: 'typescript' | 'python' | 'go',
  source: string,
): RawImport[] {
  switch (language) {
    case 'typescript':
      return typescriptImports(source);
    case 'python':
      return pythonImports(source);
    case 'go':
      return goImports(source);
  }
}
