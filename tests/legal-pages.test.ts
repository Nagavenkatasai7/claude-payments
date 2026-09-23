import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Program-Fix 15 PR A — /terms, /privacy and /legal as structured DRAFTS for
// counsel review. Owner decision: every page shows the draft banner and never
// claims approval. Recommendation C3: the licensed partner named on the
// customer's receipt is the provider of record; SmartRemit is the technology
// provider and never holds funds. Every import is dynamic so each test fails
// on its own while red.

const BANNER = 'Draft — for counsel review; not legal advice and not yet approved';

type DraftModule = typeof import('@/lib/legal/drafts');

async function drafts(): Promise<DraftModule> {
  return import('@/lib/legal/drafts');
}

function allDraftText(d: DraftModule): string {
  const docs = [d.TERMS_DRAFT, d.PRIVACY_DRAFT, d.REMITTANCE_RIGHTS_DRAFT, d.LICENSING_DRAFT, d.SCHEDULED_TRANSFERS_DRAFT];
  return docs
    .flatMap((doc) => [
      doc.title,
      doc.summary,
      ...doc.sections.flatMap((s) => [s.heading, ...s.paragraphs, ...(s.bullets ?? [])]),
    ])
    .join('\n');
}

async function renderPage(route: 'terms' | 'privacy' | 'legal'): Promise<string> {
  const mod =
    route === 'terms'
      ? await import('@/app/terms/page')
      : route === 'privacy'
        ? await import('@/app/privacy/page')
        : await import('@/app/legal/page');
  return renderToStaticMarkup(createElement(mod.default));
}

describe('src/lib/legal/drafts.ts', () => {
  it('exports the version id and the owner banner verbatim', async () => {
    const d = await drafts();
    expect(d.LEGAL_DRAFT_VERSION).toBe('draft-2026-09-23c'); // Program-Fix 49B: the rate-lock wording matches the system (30 min)
    expect(d.LEGAL_DRAFT_BANNER).toBe(BANNER);
  });

  it('every draft document is non-empty, carries the version, and has unique anchor ids', async () => {
    const d = await drafts();
    for (const doc of [d.TERMS_DRAFT, d.PRIVACY_DRAFT, d.REMITTANCE_RIGHTS_DRAFT, d.LICENSING_DRAFT, d.SCHEDULED_TRANSFERS_DRAFT]) {
      expect(doc.version).toBe(d.LEGAL_DRAFT_VERSION);
      expect(doc.sections.length).toBeGreaterThan(0);
      const ids = doc.sections.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of doc.sections) {
        expect(s.id).toMatch(/^[a-z0-9-]+$/);
        expect(s.paragraphs.length + (s.bullets?.length ?? 0)).toBeGreaterThan(0);
      }
    }
  });

  it('PR B: no draft still says partner disclosures are a future feature (the receipt and pay page show them now)', async () => {
    const text = allDraftText(await drafts());
    expect(text).not.toMatch(/once partner disclosures are enabled/i);
    expect(text).toMatch(/where the partner has supplied/i); // still conditional on what the partner supplied
  });

  it('no draft text claims approval (the banner is the only place the word appears)', async () => {
    const text = allDraftText(await drafts());
    expect(text).not.toMatch(/approv/i);
  });

  it('never says SmartRemit is a licensed transmitter, a bank or a custodian', async () => {
    const text = allDraftText(await drafts());
    expect(text).not.toMatch(/smartremit (is|acts as) (a |an |the )?(licensed|money transmitter|bank|custodian)/i);
    expect(text).not.toMatch(/smartremit (holds|receives|disburses) (your )?(funds|money)/i);
  });

  it('names the licensed partner on the receipt as the provider of record (C3), and SmartRemit never holds funds', async () => {
    const d = await drafts();
    const text = allDraftText(d);
    expect(text).toContain('licensed partner named on your receipt');
    expect(text).toMatch(/never holds/i);
  });

  it('invents no placeholder, licence number or regulator name', async () => {
    const text = allDraftText(await drafts());
    expect(text).not.toMatch(/placeholder|lorem|\[[A-Z][^\]]*\]|TODO|TBD/);
  });

  it('the privacy draft has a GLBA-style notice and a WhatsApp data section', async () => {
    const d = await drafts();
    const ids = d.PRIVACY_DRAFT.sections.map((s) => s.id);
    expect(ids).toContain('glba-notice');
    expect(ids).toContain('whatsapp');
  });

  it('the remittance-rights draft covers error resolution and the 30-minute cancellation', async () => {
    const d = await drafts();
    const ids = d.REMITTANCE_RIGHTS_DRAFT.sections.map((s) => s.id);
    expect(ids).toContain('error-resolution');
    expect(ids).toContain('cancellation');
    expect(allDraftText(d)).toMatch(/30 minutes/);
  });
});

// PR #314 review: no draft may state as present fact something the product
// does not do today (receipt partner details shipped with PR B; the cancel
// mechanics arrive with PR C, scheduling disclosures later).
describe('drafts claim only what the product does today', () => {
  // PR B ships the receipt + pay-page provider block, so the wording is present
  // tense now — but every licence / regulator detail stays conditional on what
  // the partner supplied, and the demo tenant's note is still carried.
  it('receipt partner details: present tense (PR B shipped them), still conditional on what the partner supplied', async () => {
    const d = await drafts();
    const complaints = d.REMITTANCE_RIGHTS_DRAFT.sections.find((s) => s.id === 'complaints')!.paragraphs.join(' ');
    expect(complaints).toMatch(/receipt also names the state regulator that licenses the partner, where the partner has supplied it/i);
    const provider = d.LICENSING_DRAFT.sections.find((s) => s.id === 'provider')!.paragraphs;
    expect(provider.join(' ')).toMatch(/where the partner has supplied them/i);
    expect(provider.join(' ')).toMatch(/licensing details are pending/i);
    expect(provider).toContain(d.DEMO_NO_PARTNER_NOTE);
    expect(allDraftText(d)).not.toMatch(/are shown with your transfer receipt/i);
  });

  it('the rate is described as locked for up to the real lock in the chat, not fixed on the pay page', async () => {
    const d = await drafts();
    const quotes = d.TERMS_DRAFT.sections.find((s) => s.id === 'quotes-and-fees')!;
    const text = quotes.paragraphs.join(' ');
    expect(text).not.toMatch(/fixed when you confirm/i);
    expect(text).not.toMatch(/about 10 minutes/);
    expect(text).toContain('locked for up to 30 minutes');
    expect(text).toMatch(/expired/i);
  });

  it('Program-Fix 49B: the draft states the same lock minutes the approve card shows for a fresh rate', async () => {
    const d = await drafts();
    const { RATE_LOCK_MINUTES, buildApproveSummary } = await import('@/lib/tools');
    const text = d.TERMS_DRAFT.sections.find((s) => s.id === 'quotes-and-fees')!.paragraphs.join(' ');
    const card = buildApproveSummary(
      { amountUsd: 100, feeUsd: 1.99, totalChargeUsd: 101.99, fxRate: 83, amountInr: 8300, deliveryEstimate: 'within minutes',
        sourceCurrency: 'USD', amountSource: 100, feeSource: 1.99, totalChargeSource: 101.99 },
      'Test', 'bank', '', 'bank_transfer',
    );
    const cardMinutes = Number(/Rate locked for (\d+) min\./.exec(card)?.[1]);
    const draftMinutes = Number(/locked for up to (\d+) minutes/.exec(text)?.[1]);
    expect(cardMinutes).toBe(RATE_LOCK_MINUTES);
    expect(draftMinutes).toBe(cardMinutes);
  });

  it('the scheduled-transfer note says scheduling disclosures are not yet shown and cancelling is in the chat', async () => {
    const d = await drafts();
    const text = d.SCHEDULED_TRANSFERS_DRAFT.sections.flatMap((s) => s.paragraphs).join(' ');
    expect(text).toMatch(/not yet shown/i);
    expect(text).toMatch(/chat/i);
    expect(text).not.toMatch(/disclosures are given when you schedule/i);
  });

  it('the remittance rights carry a still-being-built status line', async () => {
    const d = await drafts();
    const first = d.REMITTANCE_RIGHTS_DRAFT.sections[0];
    expect(first.id).toBe('status');
    expect(first.paragraphs.join(' ')).toMatch(/still being built/i);
  });

  it('the licensing provider section and the /about footer say the demonstration has no licensed partner', async () => {
    const d = await drafts();
    const provider = d.LICENSING_DRAFT.sections.find((s) => s.id === 'provider')!;
    expect(provider.paragraphs.join(' ')).toContain(d.DEMO_NO_PARTNER_NOTE);
    expect(d.DEMO_NO_PARTNER_NOTE).toMatch(/no licensed partner is attached and no real money moves/);
    const about = readFileSync(resolve(process.cwd(), 'src/app/about/page.tsx'), 'utf-8');
    expect(about).toContain('DEMO_NO_PARTNER_NOTE');
  });

  it('chat retention matches the 30-days-after-last-message conversation TTL', async () => {
    const d = await drafts();
    const wa = d.PRIVACY_DRAFT.sections.find((s) => s.id === 'whatsapp')!;
    expect(wa.paragraphs.join(' ')).toMatch(/30 days after your last message/);
  });
});

describe.each(['terms', 'privacy', 'legal'] as const)('/%s page', (route) => {
  it('renders the draft banner, the version id, one h1 and a #main target', async () => {
    const d = await drafts();
    const html = await renderPage(route);
    expect(html).toContain(BANNER);
    expect(html).toMatch(/DRAFT — for counsel review/i);
    expect(html).toContain(d.LEGAL_DRAFT_VERSION);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html.match(/id="main"/g)).toHaveLength(1);
    expect(html).toContain('href="#main"');
  });

  it('contains no approval wording outside the banner', async () => {
    const html = (await renderPage(route)).split(BANNER).join('');
    expect(html).not.toMatch(/approv/i);
  });

  it('links the other two legal pages', async () => {
    const html = await renderPage(route);
    for (const other of ['/terms', '/privacy', '/legal'].filter((p) => p !== `/${route}`)) {
      expect(html).toContain(`href="${other}"`);
    }
  });
});

describe('/legal anchors', () => {
  it('has #remittance-rights (PR B links the pay page and receipt to it) and #licensing', async () => {
    const html = await renderPage('legal');
    expect(html).toContain('id="remittance-rights"');
    expect(html).toContain('id="licensing"');
    expect(html).toContain('id="scheduled-transfers"');
    expect(html).toContain('licensed partner named on your receipt');
  });
});

describe('footer and /about links (source read: both pages load next/font)', () => {
  const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');

  it('/about no longer ships the licensing placeholder and links the three legal pages', () => {
    const src = read('src/app/about/page.tsx');
    expect(src).not.toMatch(/placeholder/i);
    for (const p of ['/terms', '/privacy', '/legal']) expect(src).toContain(`href="${p}"`);
  });

  it('the landing footer links the three legal pages', () => {
    const src = read('src/app/page.tsx');
    const footer = src.slice(src.indexOf('<footer'));
    for (const p of ['/terms', '/privacy', '/legal']) expect(footer).toContain(`href="${p}"`);
  });
});
