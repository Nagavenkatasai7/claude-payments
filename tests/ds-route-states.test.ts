import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeSegmentsMissingStates } from './helpers-ui-scan';
import { NEW_UI_ROOTS, STATE_EXEMPT_DIRS } from '@/lib/ui/new-ui-roots';

describe('routeSegmentsMissingStates (walker self-test)', () => {
  it('flags a segment with page.tsx but no loading/error, and passes a complete one', () => {
    const d = mkdtempSync(join(tmpdir(), 'seg-'));
    try {
      mkdirSync(join(d, 'a'));
      writeFileSync(join(d, 'a', 'page.tsx'), '');
      mkdirSync(join(d, 'b'));
      for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) writeFileSync(join(d, 'b', f), '');
      mkdirSync(join(d, 'b', 'c'));
      writeFileSync(join(d, 'b', 'c', 'page.tsx'), '');
      writeFileSync(join(d, 'b', 'c', 'loading.tsx'), '');
      const miss = routeSegmentsMissingStates(d).map((p) => p.slice(d.replaceAll('\\', '/').length));
      expect(miss).toEqual(['/a/loading.tsx', '/a/error.tsx', '/b/c/error.tsx']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('an exempt dir is skipped', () => {
    const d = mkdtempSync(join(tmpdir(), 'seg-'));
    try {
      mkdirSync(join(d, 'static'));
      writeFileSync(join(d, 'static', 'page.tsx'), '');
      expect(routeSegmentsMissingStates(d, ['static'])).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('every NEW route segment has loading.tsx and error.tsx', () => {
  it('holds for all NEW_UI_ROOTS under src/app', () => {
    const missing = NEW_UI_ROOTS.filter((r) => r.startsWith('src/app/')).flatMap((r) =>
      routeSegmentsMissingStates(r, STATE_EXEMPT_DIRS),
    );
    expect(missing).toEqual([]);
  });
});
