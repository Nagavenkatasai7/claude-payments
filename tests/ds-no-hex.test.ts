import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findHexLiterals } from './helpers-ui-scan';

describe('findHexLiterals (the scanner itself)', () => {
  it('finds #rgb/#rrggbb/#rrggbbaa and reports file:line', () => {
    const d = mkdtempSync(join(tmpdir(), 'hex-'));
    writeFileSync(join(d, 'a.tsx'), 'const ok = "text-ds-ink";\nconst bad = "bg-[#0c5bd2]";\n'); // files() sorts: a.tsx before b.ts
    writeFileSync(join(d, 'b.ts'), 'export const c = "#FFF";');
    const hits = findHexLiterals(d);
    expect(hits.map((h) => [h.file.endsWith('a.tsx') || h.file.endsWith('b.ts'), h.line, h.match])).toEqual([
      [true, 2, '#0c5bd2'],
      [true, 1, '#FFF'],
    ]);
  });
  it('ignores in-page anchors like href="#main"', () => {
    const d = mkdtempSync(join(tmpdir(), 'hex-'));
    writeFileSync(join(d, 'a.tsx'), '<a href="#main">skip</a>');
    expect(findHexLiterals(d)).toEqual([]);
  });
});

describe('no hard-coded hex in new UI code (SPEC §1.1)', () => {
  it('every NEW_UI_ROOTS directory is hex-free (token definitions live in tailwind.css only)', async () => {
    const { NEW_UI_ROOTS, HEX_EXEMPT_FILES } = await import('@/lib/ui/new-ui-roots');
    const hits = NEW_UI_ROOTS.flatMap((r) => findHexLiterals(r)).filter(
      (h) => !HEX_EXEMPT_FILES.some((e) => h.file.replaceAll('\\', '/').endsWith(e)),
    );
    expect(hits).toEqual([]);
  });
  it('every top-level src/app directory is classified as legacy or new (forces new routes into the scan)', async () => {
    const { NEW_UI_ROOTS, LEGACY_APP_DIRS } = await import('@/lib/ui/new-ui-roots');
    const appDirs = readdirSync('src/app').filter((n) => statSync(join('src/app', n)).isDirectory());
    const unclassified = appDirs.filter((n) => !LEGACY_APP_DIRS.includes(n) && !NEW_UI_ROOTS.includes(`src/app/${n}`));
    expect(unclassified).toEqual([]);
  });
});
