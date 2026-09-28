import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { PARTNER_ROUTES, partnerNav, routeAllows } from '@/app/partner/routes';
import { KNOWN_PARTNER_ROLES } from '@/lib/partner-access';

// UI redesign M3-2: the ONE route/policy table for /partner. The nav is derived from it, so the
// nav can never show a link the page refuses, and every registered route must have a page.
const pageFile = (href: string) =>
  href === '/partner' ? 'src/app/partner/(app)/page.tsx' : `src/app/partner/(app)${href.slice('/partner'.length)}/page.tsx`;

describe('PARTNER_ROUTES', () => {
  it('every registered route has a page (no dead nav links)', () => {
    for (const r of Object.values(PARTNER_ROUTES)) expect(existsSync(pageFile(r.href)), r.href).toBe(true);
  });
  it('home and security allow every role (the gate fallbacks can never loop)', () => {
    for (const role of KNOWN_PARTNER_ROLES) {
      expect(routeAllows('home', role)).toBe(true);
      expect(routeAllows('security', role)).toBe(true);
    }
  });
  it('partnerNav only lists routes the role may open', () => {
    for (const role of KNOWN_PARTNER_ROLES) {
      const nav = partnerNav(role);
      expect(nav.length).toBeGreaterThan(0);
      for (const r of nav) expect(r.policy.roles).toContain(role);
    }
  });
  it('partnerNav keeps the fixed order, home first', () => {
    expect(partnerNav('admin').map((r) => r.href)).toEqual(['/partner', '/partner/audit', '/partner/security']);
    expect(partnerNav('agent').map((r) => r.href)).not.toContain('/partner/audit');
  });
  it('an unknown role gets no nav at all (fails closed)', () => {
    expect(partnerNav('root' as never)).toEqual([]);
  });
  it('M3-6: finance gets home + security, and only routes whose policy admits finance', () => {
    const hrefs = partnerNav('finance').map((r) => r.href);
    expect(hrefs[0]).toBe('/partner');
    expect(hrefs).toContain('/partner/security');
    for (const r of partnerNav('finance')) expect(r.policy.roles).toContain('finance');
  });
  it('hrefs are static paths (no tenant, no query string)', () => {
    for (const r of Object.values(PARTNER_ROUTES)) expect(r.href).toMatch(/^\/partner(\/[a-z-]+)*$/);
  });
  it('the table is frozen (no runtime additions)', () => {
    expect(Object.isFrozen(PARTNER_ROUTES)).toBe(true);
  });
});
