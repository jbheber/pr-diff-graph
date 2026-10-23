// Builds the report client: `node scripts/build.mjs client [outDir]` (default outDir: build/client).
// Writes report-client.js (one IIFE with every library bundled in, headed by a THIRD_PARTY_NOTICES
// comment), report-client.css (diff2html's stylesheet inlined) and a copy of template.html.
import console from 'node:console';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
  return file ? readFileSync(join(pkgDir, file), 'utf8').trim() : null;
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

const [target = 'client', out] = process.argv.slice(2);
if (target !== 'client') {
  console.error(`unknown build target: ${target} (expected: client)`);
  process.exit(1);
}
const outDir = resolve(root, out ?? join('build', 'client'));
if (!existsSync(clientDir)) throw new Error(`missing ${clientDir}`);
await buildClient(outDir);
