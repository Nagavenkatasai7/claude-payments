#!/usr/bin/env node
/**
 * Builds the Program Ledger v2 page: inlines scripts/tracker/page/page-logic.mjs into
 * scripts/tracker/page/ledger-page.src.html at the PAGE_LOGIC marker and writes
 * scripts/tracker/ledger-page.html (the file the Artifact publish uses; committed).
 *
 *   node scripts/tracker/build-page.mjs           write ledger-page.html
 *   node scripts/tracker/build-page.mjs --check   exit 1 when ledger-page.html is out of date
 *
 * The logic module's `export` keywords are stripped and its body is wrapped in a function scope
 * that returns every exported name, so the page script reads it as `PL.<name>`.
 * Node built-ins only (the routine runs this without npm install).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MARKER = '/*@@PAGE_LOGIC@@*/';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const SRC_PATH = here('./page/ledger-page.src.html');
export const LOGIC_PATH = here('./page/page-logic.mjs');
export const OUT_PATH = here('./ledger-page.html');

/**
 * The page-logic module as a classic-script expression: `(() => { ...; return {names}; })()`.
 * @param {string} logicSrc
 * @returns {string}
 */
export function inlineLogic(logicSrc) {
  if (/^\s*import\s/m.test(logicSrc)) throw new Error('page-logic.mjs must not import anything');
  const names = [...logicSrc.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  if (!names.length) throw new Error('page-logic.mjs exports nothing');
  const body = logicSrc.replace(/^export\s+/gm, '').trimEnd();
  return `(() => {\n${body}\n\nreturn { ${names.join(', ')} };\n})()`;
}

/**
 * The built page HTML from the source page and the logic module.
 * @param {{src?: string, logic?: string}} [inputs] defaults read the files on disk
 * @returns {string}
 */
export function buildPageHtml({ src = readFileSync(SRC_PATH, 'utf8'), logic = readFileSync(LOGIC_PATH, 'utf8') } = {}) {
  const at = src.indexOf(MARKER);
  if (at < 0 || src.indexOf(MARKER, at + MARKER.length) >= 0) throw new Error(`ledger-page.src.html must hold ${MARKER} exactly once`);
  return src.slice(0, at) + inlineLogic(logic) + src.slice(at + MARKER.length);
}

function main(argv) {
  const html = buildPageHtml();
  if (argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(OUT_PATH, 'utf8'); } catch { /* missing counts as out of date */ }
    if (current !== html) {
      process.stderr.write('scripts/tracker/ledger-page.html is out of date: run node scripts/tracker/build-page.mjs\n');
      process.exit(1);
    }
    process.stdout.write('ledger-page.html is up to date\n');
    return;
  }
  writeFileSync(OUT_PATH, html);
  process.stdout.write(`wrote ${OUT_PATH} (${html.length} bytes)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
