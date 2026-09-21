import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BeforeSendMiddleware } from '@vercel/speed-insights';
import { scrubVitalsEvent, DYNAMIC_PAGE_ROUTES } from '@/lib/vitals-scrub';

// Compile-time: the helper must satisfy the package's own beforeSend contract
// (node_modules/@vercel/speed-insights/dist/index.d.ts:15-20).
const asMiddleware: BeforeSendMiddleware = scrubVitalsEvent;
void asMiddleware;

const ORIGIN = 'https://smartremit.ai';

type Ev = Parameters<BeforeSendMiddleware>[0];
const ev = (url: string, route?: string): Ev =>
  route === undefined ? { type: 'vital', url } : { type: 'vital', url, route };

// Real id shapes (src/lib/id.ts newTransferId = 8 lowercase base36; prefixes
// from their mint sites; phones are digits-only per src/lib/phone.ts; the
// partner application token is randomBytes(32).toString('hex')).
const TRANSFER_ID = 'k3j9x0ab';
const TRANSFER_ID_ALL_LETTERS = 'qwertyui'; // ~7% of base36 ids have no digit
const HEX64 = 'a'.repeat(8) + '0123456789abcdef'.repeat(3) + 'f'.repeat(8);

const DYNAMIC_CASES: Array<[template: string, concrete: string, secret: string]> = [
  ['/pay/[transferId]', `/pay/${TRANSFER_ID}`, TRANSFER_ID],
  ['/pay/b2b/[invoiceId]', '/pay/b2b/inv_k3j9x0ab', 'inv_k3j9x0ab'],
  ['/account/receipt/[transferId]', `/account/receipt/${TRANSFER_ID}`, TRANSFER_ID],
  ['/account/support/[ticketId]', '/account/support/tk_k3j9x0ab', 'tk_k3j9x0ab'],
  ['/admin-dashboard/customers/[phone]', '/admin-dashboard/customers/919876543210', '919876543210'],
  ['/admin-dashboard/employee-questions/[ticketId]', '/admin-dashboard/employee-questions/tk_7h2kq9zx', 'tk_7h2kq9zx'],
  ['/admin-dashboard/partner-requests/[id]', '/admin-dashboard/partner-requests/preq_k3j9x0ab', 'preq_k3j9x0ab'],
  ['/admin-dashboard/partners/[id]', '/admin-dashboard/partners/acme-remit', 'acme-remit'],
  ['/admin-dashboard/tickets/[ticketId]', '/admin-dashboard/tickets/tk_k3j9x0ab', 'tk_k3j9x0ab'],
  ['/admin-dashboard/transactions/[id]', `/admin-dashboard/transactions/${TRANSFER_ID}`, TRANSFER_ID],
  ['/onboard/seller/[id]', '/onboard/seller/s_k3j9x0ab', 's_k3j9x0ab'],
  ['/partners/apply/[token]', `/partners/apply/${HEX64}`, HEX64],
];

describe('scrubVitalsEvent — query string and hash', () => {
  it('drops the query string and hash (they can carry tokens)', () => {
    const out = scrubVitalsEvent(
      ev(`${ORIGIN}/account/verify?token=sekret123&email=a%40b.com#otp=999999`, '/account/verify'),
    );
    expect(out).toEqual({ type: 'vital', url: `${ORIGIN}/account/verify`, route: '/account/verify' });
  });

  it('drops the query and hash in the no-route fallback too', () => {
    const out = scrubVitalsEvent(ev(`${ORIGIN}/account/reset?t=abc#x`));
    expect(out).toEqual({ type: 'vital', url: `${ORIGIN}/account/reset` });
  });

  it('drops URL userinfo', () => {
    const out = scrubVitalsEvent(ev('https://user:pw@smartremit.ai/about', '/about'));
    expect(out?.url).toBe(`${ORIGIN}/about`);
  });
});

describe('scrubVitalsEvent — templated route replaces the real path', () => {
  it.each(DYNAMIC_CASES)('%s', (template, concrete, secret) => {
    const out = scrubVitalsEvent(ev(`${ORIGIN}${concrete}?partner=default#top`, template));
    expect(out).toEqual({ type: 'vital', url: `${ORIGIN}${template}`, route: template });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  // The hosted script takes only `url` from our return value and sends `route`
  // verbatim from data-route, so a route that itself needs scrubbing (an
  // unmatched/404 path, or an untemplated id) cannot be fixed here: drop it.
  it.each([
    ['untemplated transfer id', `/pay/${TRANSFER_ID}`],
    ['untemplated all-letter transfer id', `/pay/${TRANSFER_ID_ALL_LETTERS}`],
    ['404 path carrying an id', `/pay/${TRANSFER_ID}/extra`],
    ['404 path carrying a phone', '/customers/919876543210'],
    ['relative route', 'pay/whatever'],
  ])('drops the event when the route itself is unsafe: %s', (_label, route) => {
    expect(scrubVitalsEvent(ev(`${ORIGIN}${route.startsWith('/') ? route : '/x'}`, route))).toBeNull();
  });

  it('keeps a 404 route with no id-shaped segment', () => {
    expect(scrubVitalsEvent(ev(`${ORIGIN}/no-such-page?q=1`, '/no-such-page'))).toEqual({
      type: 'vital',
      url: `${ORIGIN}/no-such-page`,
      route: '/no-such-page',
    });
  });

  it('keeps a route the SDK templated from a query value on a static page', () => {
    // computeRoute('/account/verify', {step: 'verify'}) === '/account/[step]'
    expect(scrubVitalsEvent(ev(`${ORIGIN}/account/verify?step=verify`, '/account/[step]'))?.url).toBe(
      `${ORIGIN}/account/[step]`,
    );
  });
});

describe('scrubVitalsEvent — no route: known dynamic pages map to their template', () => {
  it.each(DYNAMIC_CASES)('%s', (template, concrete, secret) => {
    const out = scrubVitalsEvent(ev(`${ORIGIN}${concrete}`));
    expect(out).toEqual({ type: 'vital', url: `${ORIGIN}${template}` });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it('masks an all-letter transfer id that id-shape rules alone would miss', () => {
    for (const p of ['/pay', '/account/receipt', '/admin-dashboard/transactions']) {
      const out = scrubVitalsEvent(ev(`${ORIGIN}${p}/${TRANSFER_ID_ALL_LETTERS}`));
      expect(out?.url).not.toContain(TRANSFER_ID_ALL_LETTERS);
    }
  });

  it('keeps static pages that sit beside a dynamic sibling', () => {
    for (const p of [
      '/account/support/new',
      '/admin-dashboard/customers/new',
      '/admin-dashboard/partners/new',
      '/admin-dashboard/tickets/my-queue',
    ]) {
      expect(scrubVitalsEvent(ev(`${ORIGIN}${p}`))?.url).toBe(`${ORIGIN}${p}`);
    }
  });
});

describe('scrubVitalsEvent — no route: id-shaped segments on unknown paths are masked', () => {
  it.each([
    ['base36 id with digits', `/track/${TRANSFER_ID}`, '/track/[id]'],
    ['uuid', '/x/123e4567-e89b-12d3-a456-426614174000', '/x/[id]'],
    ['all-letter uuid-shaped', '/x/abcdefab-abcd-abcd-abcd-abcdefabcdef', '/x/[id]'],
    ['txn_ prefixed id', '/x/txn_abcdefgh', '/x/[id]'],
    ['tr_ prefixed id', '/x/tr_abcdefgh/receipt', '/x/[id]/receipt'],
    ['16+ char token', '/x/abcdefghijklmnop', '/x/[id]'],
    ['64-hex token', `/x/${HEX64}`, '/x/[id]'],
    ['phone digits', '/x/919876543210', '/x/[id]'],
    ['encoded +phone', '/x/%2B919876543210', '/x/[id]'],
    ['short numeric id', '/x/42', '/x/[id]'],
    ['email', '/x/jane@example.com', '/x/[id]'],
    ['mixed-case base64url token', '/x/AbCdEfGh', '/x/[id]'],
  ])('%s', (_label, path, expected) => {
    expect(scrubVitalsEvent(ev(`${ORIGIN}${path}`))?.url).toBe(`${ORIGIN}${expected}`);
  });

  it('keeps route-folder-shaped segments, including long hyphenated ones and b2b', () => {
    for (const p of [
      '/admin-dashboard/employee-questions',
      '/admin-dashboard/partner-requests',
      '/admin-dashboard/b2b',
      '/admin-dashboard/api-keys',
      '/',
    ]) {
      expect(scrubVitalsEvent(ev(`${ORIGIN}${p}`))?.url).toBe(`${ORIGIN}${p}`);
    }
  });

  it('keeps a relative URL relative', () => {
    expect(scrubVitalsEvent(ev(`/pay/${TRANSFER_ID}?x=1#y`))).toEqual({
      type: 'vital',
      url: '/pay/[transferId]',
    });
  });
});

describe('scrubVitalsEvent — never throws, drops instead of leaking', () => {
  it.each([
    ['null event', null],
    ['undefined event', undefined],
    ['non-string url', { type: 'vital', url: 42 }],
    ['empty url', { type: 'vital', url: '' }],
    ['unparseable url', { type: 'vital', url: 'http://' }],
    ['protocol-relative url', { type: 'vital', url: '//evil.example/pay/k3j9x0ab' }],
    ['non-http scheme', { type: 'vital', url: 'javascript:alert(1)' }],
    ['data scheme', { type: 'vital', url: 'data:text/plain,hi' }],
  ])('%s -> null', (_label, input) => {
    expect(() => scrubVitalsEvent(input as unknown as Ev)).not.toThrow();
    expect(scrubVitalsEvent(input as unknown as Ev)).toBeNull();
  });

  it('returns null when reading the event throws', () => {
    const hostile = {
      type: 'vital',
      get url(): string {
        throw new Error('boom');
      },
    } as unknown as Ev;
    expect(scrubVitalsEvent(hostile)).toBeNull();
  });

  it('forwards only type/url/route — unknown fields are not passed through', () => {
    const withExtra = { ...ev(`${ORIGIN}/about`, '/about'), referrer: `${ORIGIN}/pay/${TRANSFER_ID}?t=x` };
    expect(Object.keys(scrubVitalsEvent(withExtra as Ev) ?? {}).sort()).toEqual(['route', 'type', 'url']);
  });
});

// ── Drift guard: the route table and the scrub rules must match src/app ─────
function pageRoutes(): string[] {
  const appDir = join(process.cwd(), 'src', 'app');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (dir === appDir && name === 'api') continue; // API routes render no page
        walk(full);
      } else if (name === 'page.tsx') {
        const rel = relative(appDir, dir).split(sep).filter(Boolean);
        out.push(`/${rel.join('/')}`);
      }
    }
  };
  walk(appDir);
  return out.sort();
}

describe('scrubVitalsEvent — pinned to the real page tree (src/app)', () => {
  const routes = pageRoutes();
  const dynamic = routes.filter((r) => r.includes('['));
  const statics = routes.filter((r) => !r.includes('['));

  it('DYNAMIC_PAGE_ROUTES lists exactly the dynamic pages under src/app', () => {
    expect([...DYNAMIC_PAGE_ROUTES].sort()).toEqual(dynamic);
  });

  it('every dynamic page has a real-id case in this suite', () => {
    expect(DYNAMIC_CASES.map(([t]) => t).sort()).toEqual(dynamic);
  });

  it('every static page survives the no-route fallback unchanged', () => {
    expect(statics.length).toBeGreaterThan(20);
    for (const r of statics) {
      expect(scrubVitalsEvent(ev(`${ORIGIN}${r}`))?.url).toBe(`${ORIGIN}${r}`);
    }
  });

  it('no real page route is dropped when the SDK reports it as the route', () => {
    for (const r of routes) {
      expect(scrubVitalsEvent(ev(`${ORIGIN}${r}`, r)), r).toEqual({ type: 'vital', url: `${ORIGIN}${r}`, route: r });
    }
  });
});
