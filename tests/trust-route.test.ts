import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

// UI redesign M4 PR-6: /trust is a static, data-free server page in the landing shell, UNLINKED
// and noindex until the post-demo swap. The page module is pinned by source (like /docs-next).

describe('/trust route contract (source)', () => {
  it('the layout wraps the SiteShell, titles the page and sets noindex (and only the layout sets robots)', () => {
    const layout = readFileSync('src/app/trust/layout.tsx', 'utf8');
    expect(layout).toMatch(/SiteShell/);
    expect(layout).toMatch(/Trust & security/);
    expect(layout).toMatch(/robots: \{ index: false, follow: false \}/);
    expect(readFileSync('src/app/trust/page.tsx', 'utf8')).not.toMatch(/\brobots\s*:/);
  });
  it('the page renders from the trust content modules, with a PageHeader and a #disclosure section', () => {
    const page = readFileSync('src/app/trust/page.tsx', 'utf8');
    for (const m of ['compliance-status', 'subprocessors', 'security-overview', 'disclosure'])
      expect(page).toContain(`@/content/trust/${m}`);
    expect(page).toMatch(/PageHeader/);
    expect(page).toMatch(/id="disclosure"/);
    expect(page).toMatch(/EmptyState/);
    expect(page).not.toMatch(/dangerouslySetInnerHTML|<script/);
  });
});

describe('/trust segment states', () => {
  it('is state-exempt and has NO loading.tsx (it would hide the prerendered page behind a skeleton)', async () => {
    const { STATE_EXEMPT_DIRS } = await import('@/lib/ui/new-ui-roots');
    expect(STATE_EXEMPT_DIRS).toContain('src/app/trust');
    expect(existsSync('src/app/trust/loading.tsx')).toBe(false);
  });
  it('has error.tsx, the shared digest-only boundary', () => {
    const err = readFileSync('src/app/trust/error.tsx', 'utf8');
    expect(err).toMatch(/^'use client';/);
    expect(err).toMatch(/export \{ SegmentError as default \} from '@\/components\/ds\/segment-error';/);
  });
});

describe('the route-mode baseline pins /trust as prerendered', () => {
  it('static', () => {
    const b = JSON.parse(readFileSync('scripts/route-modes.baseline.json', 'utf8')) as Record<string, string>;
    expect(b['/trust']).toBe('static');
  });
});
