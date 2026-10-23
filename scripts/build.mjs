// `node scripts/build.mjs client [outDir]` builds the report client (default outDir: build/client):
// report-client.js (one IIFE with every library bundled in, headed by a THIRD_PARTY_NOTICES
// comment), report-client.css (diff2html's stylesheet inlined) and a copy of template.html.
//
// `node scripts/build.mjs dist` builds the committed dist/: the action (dist/index.js) and the CLI
// (dist/cli/index.js) as ESM bundles, the report client and template, and dist/grammars/. Both
// bundles find the shared files from their own location (`grammarDir`, `reportAssetsDir`).
import console from 'node:console';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = join(root, 'src', 'report', 'client');

/** `node_modules/<name>` (scoped or not) of each bundled input file, deduplicated. */
function packagesOf(metafile) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll('\\', '/'));
    if (m) dirs.add(m[1]);
  }
  return [...dirs].sort();
}

function licenseText(pkgDir) {
  const file = readdirSync(pkgDir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  // Some license files have CRLF line ends; git would normalize them and dist/ would not match.
  if (!file) return null;
  return readFileSync(join(pkgDir, file), 'utf8').replace(/\r\n?/g, '\n').trim();
}

/** One block comment with the name, version, license and license text of every bundled package. */
function notices(metafile) {
  const parts = packagesOf(metafile).map((dir) => {
    const pkgDir = resolve(root, dir);
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const text = licenseText(pkgDir) ?? `License: ${pkg.license} (no license file shipped)`;
    return `${pkg.name}@${pkg.version} (${pkg.license})\n\n${text}`;
  });
  const body = parts.join('\n\n' + '-'.repeat(72) + '\n\n').replaceAll('*/', '* /');
  return `/*! THIRD_PARTY_NOTICES\n\nThis file bundles the following packages.\n\n${body}\n*/\n`;
}

/** The report must load nothing from the network. */
function assertOffline(name, text) {
  const bad = [/url\(\s*["']?https?:/i, /@import/i, /(src|href)\s*=\s*["']https?:/i].find((re) =>
    re.test(text),
  );
  if (bad) throw new Error(`${name} references the network (${bad})`);
}

async function buildClient(outDir) {
  mkdirSync(outDir, { recursive: true });
  const js = await esbuild.build({
    entryPoints: [join(clientDir, 'index.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    metafile: true,
    write: false,
    logLevel: 'warning',
  });
  const jsText = notices(js.metafile) + js.outputFiles[0].text;

  const css = await esbuild.build({
    entryPoints: [join(clientDir, 'styles.css')],
    bundle: true,
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
  });
  const cssText = css.outputFiles[0].text;

  assertOffline('report-client.js', jsText);
  assertOffline('report-client.css', cssText);
  writeFileSync(join(outDir, 'report-client.js'), jsText);
  writeFileSync(join(outDir, 'report-client.css'), cssText);
  copyFileSync(join(root, 'src', 'report', 'template.html'), join(outDir, 'template.html'));
  console.log(
    `report client → ${outDir} (js ${(jsText.length / 1024).toFixed(0)} KiB, css ${(cssText.length / 1024).toFixed(0)} KiB)`,
  );
}

// Bundled CommonJS dependencies call `require` for Node built-ins; ESM output has none of its own.
const REQUIRE_SHIM =
  "import { createRequire as __pdgCreateRequire } from 'node:module';\n" +
  'const require = __pdgCreateRequire(import.meta.url);';

/** One ESM bundle of a Node entry point, headed by the notices of the packages it bundles. */
async function buildNode(entry, outfile) {
  const result = await esbuild.build({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: 'node',
    // jsonc-parser's `main` is a UMD build whose requires esbuild cannot follow; prefer ESM.
    mainFields: ['module', 'main'],
    format: 'esm',
    target: 'node24',
    banner: { js: REQUIRE_SHIM },
    legalComments: 'none',
    metafile: true,
    write: false,
    logLevel: 'warning',
  });
  let text = result.outputFiles[0].text;
  const hashbang = text.startsWith('#!') ? text.slice(0, text.indexOf('\n') + 1) : '';
  text = hashbang + notices(result.metafile) + text.slice(hashbang.length);
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, text);
  console.log(`${entry} → ${outfile} (${(text.length / 1024).toFixed(0)} KiB)`);
}

async function buildDist(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  await buildNode('src/main.ts', join(outDir, 'index.js'));
  await buildNode('src/cli.ts', join(outDir, 'cli', 'index.js'));
  await buildClient(outDir);
  const grammars = join(outDir, 'grammars');
  mkdirSync(grammars, { recursive: true });
  for (const f of readdirSync(join(root, 'grammars'))) {
    if (f.endsWith('.wasm') || f === 'VERSIONS') {
      copyFileSync(join(root, 'grammars', f), join(grammars, f));
    }
  }
}

const [target = 'client', out] = process.argv.slice(2);
if (!existsSync(clientDir)) throw new Error(`missing ${clientDir}`);
if (target === 'client') {
  await buildClient(resolve(root, out ?? join('build', 'client')));
} else if (target === 'dist') {
  await buildDist(resolve(root, out ?? 'dist'));
} else {
  console.error(`unknown build target: ${target} (expected: client or dist)`);
  process.exit(1);
}
