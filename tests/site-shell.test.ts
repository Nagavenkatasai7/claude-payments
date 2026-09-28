import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

// The shared site shell REPLICATES the landing's header and footer (owner direction
// 2026-09-28) until the post-demo swap makes the landing consume it. These tests pin
// that the two stay in step without touching src/app/page.tsx.

const decode = (s: string) => s.replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]));
const LANDING = readFileSync('src/app/page.tsx', 'utf8');
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`landing marker missing: ${from} … ${to}`);
  return src.slice(a, b);
};
// The landing's header (LoginMenu + <nav>) and footer, as literal href strings.
const LANDING_HEADER = between(LANDING, 'function LoginMenu', 'export default') + between(LANDING, '<nav', '<main');
const LANDING_FOOTER = between(LANDING, '<footer', '</footer>');
const literalHrefs = (src: string) =>
  [...src.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => h !== '#top').map((h) => (h.startsWith('#') ? `/${h}` : h));

async function render() {
  const { SiteHeader } = await import('@/components/site/SiteHeader');
  const { SiteFooter } = await import('@/components/site/SiteFooter');
  return { header: renderToStaticMarkup(createElement(SiteHeader)), footer: renderToStaticMarkup(createElement(SiteFooter)) };
}

describe('SiteHeader/SiteFooter mirror the landing (owner direction 2026-09-28)', () => {
  it('header has the logo, nav, Log in menu, Create account and Start on WhatsApp', async () => {
    const { header } = await render();
    for (const t of ['Log in', 'Create account', 'Start on WhatsApp', 'Partner with us', 'About', 'Customers', 'Employee portal', 'Partners'])
      expect(header).toContain(t);
    expect(header).toContain('href="/account/register"');
    expect(header).toMatch(/<nav[^>]*aria-label="Primary"/);
    expect(header).toContain('alt="SmartRemit.ai"');
  });

  it('the logo links home (/), not the landing-only #top', async () => {
    const { header } = await render();
    expect(header).toMatch(/<a[^>]*href="\/"[^>]*><img[^>]*alt="SmartRemit.ai"/);
    expect(header).not.toContain('href="#top"');
  });

  it('every landing header/footer link has a shell counterpart (anchors as /#…)', async () => {
    const { header, footer } = await render();
    const shell = new Set([...hrefs(header), ...hrefs(footer)]);
    const want = [...literalHrefs(LANDING_HEADER), ...literalHrefs(LANDING_FOOTER)];
    expect(want.length).toBeGreaterThan(15);
    for (const h of want) expect({ h, present: shell.has(h) }).toEqual({ h, present: true });
  });

  it('the shell links nothing the landing header/footer does not (logo /, WhatsApp, socials aside)', async () => {
    const { header, footer } = await render();
    const { waLink, WA_MESSAGES } = await import('@/app/landing/wa');
    const { default: SocialLinks } = await import('@/app/landing/SocialLinks');
    const allowed = new Set([
      '/',
      waLink(WA_MESSAGES.generic),
      ...hrefs(renderToStaticMarkup(createElement(SocialLinks))),
      ...literalHrefs(LANDING_HEADER),
      ...literalHrefs(LANDING_FOOTER),
    ]);
    for (const h of [...hrefs(header), ...hrefs(footer)]) expect({ h, allowed: allowed.has(h) }).toEqual({ h, allowed: true });
  });

  it('header and footer Start-on-WhatsApp links are the landing generic deep link, opened safely', async () => {
    const { header, footer } = await render();
    const { waLink, WA_MESSAGES, WA_PHONE, formatWaPhone } = await import('@/app/landing/wa');
    const wa = waLink(WA_MESSAGES.generic);
    expect(hrefs(header)).toContain(wa);
    expect(hrefs(footer)).toContain(wa);
    expect(footer).toContain(`WhatsApp: ${formatWaPhone(WA_PHONE)}`);
    for (const html of [header, footer])
      for (const m of html.matchAll(/<a [^>]*target="_blank"[^>]*>/g)) expect(m[0]).toContain('rel="noopener noreferrer"');
  });

  it('the login menu still points partners at /docs (swap is post-demo)', async () => {
    const { LOGIN_MENU } = await import('@/components/site/site-links');
    expect(LOGIN_MENU.map((i) => i.href)).toEqual(['/account/login', '/login', '/docs']);
    const { header } = await render();
    expect(header).toMatch(/href="\/docs"[^>]*>(<span[^>]*>)?Partners/);
  });

  it('footer carries the columns, the non-custodial disclaimer and the legal nav', async () => {
    const { footer } = await render();
    for (const t of ['Product', 'Log in', 'Account', 'Contact', 'Global money transfers, made simpler.', 'never holds,'])
      expect(footer).toContain(t);
    expect(footer).toMatch(/<nav[^>]*aria-label="Legal"/);
    expect(footer).toMatch(/<nav[^>]*aria-label="SmartRemit on social media"/);
    for (const h of ['/terms', '/privacy', '/legal']) expect(footer).toContain(`href="${h}"`);
  });

  it('keeps the landing responsive hide points (1180 / 1023 / 760 / 520) so 375 px matches the landing', async () => {
    const { header, footer } = await render();
    for (const cls of ['max-[1180px]:hidden', 'max-[1023px]:hidden', 'max-[760px]:hidden', 'min-[761px]:hidden', 'max-[520px]:sr-only'])
      expect(header).toContain(cls);
    expect(footer).toContain('max-[760px]:grid-cols-2');
    // Phones (≤760) get a plain Log in link instead of the menu.
    expect(header).toMatch(/<a[^>]*min-\[761px\]:hidden[^>]*href="\/account\/login"|<a[^>]*href="\/account\/login"[^>]*min-\[761px\]:hidden/);
  });

  it('uses ds tokens for the landing colours (no raw palette classes)', async () => {
    const { header, footer } = await render();
    // SocialLinks is reused read-only from the landing and keeps its own classes until the
    // post-demo refactor; everything the shell itself renders must be token-based.
    const { default: SocialLinks } = await import('@/app/landing/SocialLinks');
    const socials = renderToStaticMarkup(createElement(SocialLinks));
    expect(footer).toContain(socials);
    const html = header + footer.replace(socials, '');
    for (const cls of ['bg-ds-nav-bg', 'border-ds-border', 'text-ds-ink-muted', 'hover:text-ds-ink', 'bg-ds-cta-whatsapp', 'text-ds-on-whatsapp', 'text-ds-ink-faint', 'bg-ds-surface', 'shadow-ds-pop'])
      expect(html).toContain(cls);
    expect(html).not.toMatch(/\[#[0-9a-fA-F]{3,8}\]/);
  });
});

describe('LoginMenu is keyboard accessible (disclosure, not a hover-only menu)', () => {
  it('renders a button with aria-expanded=false that controls the hidden panel of real links', async () => {
    const { header } = await render();
    const btn = /<button[^>]*aria-expanded="false"[^>]*>/.exec(header)?.[0];
    expect(btn).toBeDefined();
    expect(btn).toContain('type="button"');
    const controls = /aria-controls="([^"]+)"/.exec(btn!)![1];
    const panel = new RegExp(`<div[^>]*id="${controls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`).exec(header)?.[0];
    expect(panel).toBeDefined();
    // Closed: invisible, so the links are out of the tab order until opened.
    expect(header).toMatch(/class="[^"]*\binvisible\b[^"]*"[^>]*>\s*<div[^>]*id=|id="[^"]+"[^>]*class="[^"]*\binvisible\b/);
    expect(header).not.toContain('aria-haspopup');
    expect(header).not.toContain('role="menu"');
  });
});

describe('SiteShell', () => {
  it('wraps content in the landing root look with a skip link and <main id="main">', async () => {
    const { SiteShell } = await import('@/components/site/SiteShell');
    const html = renderToStaticMarkup(createElement(SiteShell, null, createElement('p', null, 'body')));
    expect(html).toContain('href="#main"');
    expect(html).toMatch(/<main[^>]*id="main"[^>]*>[\s\S]*<p>body<\/p>[\s\S]*<\/main>/);
    for (const cls of ['font-sans', 'bg-ds-ground', 'text-ds-ink', 'leading-[1.6]', 'antialiased', 'overflow-x-clip'])
      expect(html).toContain(cls);
    expect(html.indexOf('aria-label="Primary"')).toBeLessThan(html.indexOf('<main'));
    expect(html.indexOf('<footer')).toBeGreaterThan(html.indexOf('</main>'));
  });
  it('omits the landing-only mobile sticky WhatsApp CTA (plan default Q2)', async () => {
    const { SiteShell } = await import('@/components/site/SiteShell');
    const html = renderToStaticMarkup(createElement(SiteShell, null, 'x'));
    expect(html).not.toContain('fixed inset-x-3 bottom-3');
  });
});
