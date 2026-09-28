import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = /\.(tsx?|css|mdx?)$/;
// '#' + 3,4,6 or 8 hex digits, not preceded by a word char or '&' (HTML entities) and not followed by a word char.
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

function files(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  for (const n of readdirSync(root).sort()) {
    const p = join(root, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (SRC.test(n)) out.push(p);
  }
  return out;
}

export function findHexLiterals(root: string): Array<{ file: string; line: number; match: string }> {
  const hits: Array<{ file: string; line: number; match: string }> = [];
  for (const file of files(root)) {
    readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
      for (const m of text.matchAll(HEX)) hits.push({ file, line: i + 1, match: m[0] });
    });
  }
  return hits;
}

/** Route segment dirs (containing page.tsx) under `root` that lack loading.tsx or error.tsx. */
export function routeSegmentsMissingStates(root: string, exempt: readonly string[] = []): string[] {
  const missing: string[] = [];
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    const names = readdirSync(dir).sort();
    const norm = dir.replaceAll('\\', '/');
    if (names.includes('page.tsx') && !exempt.some((e) => norm.endsWith(e))) {
      if (!names.includes('loading.tsx')) missing.push(`${norm}/loading.tsx`);
      if (!names.includes('error.tsx')) missing.push(`${norm}/error.tsx`);
    }
    for (const n of names) if (statSync(join(dir, n)).isDirectory()) visit(join(dir, n));
  };
  visit(root);
  return missing;
}
