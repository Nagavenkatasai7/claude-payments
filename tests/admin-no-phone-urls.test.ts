import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Program-Fix 37 (dash-04): no staff page builds a URL that carries a phone
// number: no `?phone=` query and no phone-keyed customer path. Customer
// navigation goes through CustomerLink (a POST to openCustomerAction, which
// redirects to the sealed-ref URL). A source guard, like bot-content-guard.

const ROOT = join(__dirname, '..', 'src', 'app', 'admin-dashboard');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('admin-dashboard builds no phone-bearing URL (Program-Fix 37)', () => {
  const all = files(ROOT).map((p) => ({ p: relative(ROOT, p), src: readFileSync(p, 'utf8') }));

  it('has no `?phone=` / `&phone=` query in any href', () => {
    const hits = all.filter(({ src }) => /[?&]phone=/.test(src)).map(({ p }) => p);
    expect(hits).toEqual([]);
  });

  it('builds customer-detail paths only from a sealed ref', () => {
    const hits = all
      .flatMap(({ p, src }) =>
        [...src.matchAll(/customers\/\$\{([^}]*)\}/g)].map((m) => ({ p, expr: m[1] })),
      )
      .filter(({ expr }) => !expr.startsWith('sealCustomerRef('));
    expect(hits).toEqual([]);
  });
});
