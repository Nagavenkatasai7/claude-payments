import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Fix pack 3 T10 (R15, R13; contract 12): the platform LiveCertificationCard. The state badge reads
// the stored live_controls only; the readiness lines show their state; never a contract or counsel
// reference. The actions are mocked (the card only renders their forms).
vi.mock('@/app/admin-dashboard/partners/go-live-actions', () => ({
  certifyLiveAction: async () => ({ ok: true }),
  revokeLiveAction: async () => ({ ok: true }),
  recordContractAction: async () => ({ ok: true }),
  recordCounselAction: async () => ({ ok: true }),
  setFundingModeAction: async () => ({ ok: true }),
  approveGoLiveAction: async () => undefined,
}));

import { LiveCertificationCard } from '@/app/admin-dashboard/partners/live-certification-card';
import { LIVE_READINESS_LINE_IDS, NOT_BUILT_LINES, type LiveReadiness } from '@/lib/live-certification';
import { EMPTY_LIVE_CONTROLS, type LiveControls } from '@/lib/live-controls';
import { STEP_UP_FIELD } from '@/lib/staff-step-up-result';
import { certifiedLiveControls } from './helpers-live';

const action = async () => ({ ok: true as const });
const readiness: LiveReadiness = {
  ok: false,
  lines: LIVE_READINESS_LINE_IDS.map((id) =>
    id in NOT_BUILT_LINES
      ? { id, state: 'not_built' as const, ok: false, builtIn: NOT_BUILT_LINES[id as keyof typeof NOT_BUILT_LINES] }
      : id === 'contract'
        ? { id, state: 'fail' as const, ok: false }
        : { id, state: 'pass' as const, ok: true },
  ),
};
const html = (o: { liveControls?: LiveControls; readiness?: LiveReadiness | 'error' } = {}) =>
  renderToStaticMarkup(
    LiveCertificationCard({
      partnerId: 'acme',
      liveControls: o.liveControls ?? EMPTY_LIVE_CONTROLS,
      readiness: o.readiness ?? readiness,
      certifyAction: action,
      revokeAction: action,
      contractAction: action,
      counselAction: action,
      fundingModeAction: action,
    }),
  );
const stateOf = (h: string) => /data-testid="live-cert-state"[^>]*>([^<]*)</.exec(h)?.[1];
const certified = () => certifiedLiveControls({ optIns: ['b2b'] });
const revoked = (): LiveControls => {
  const lc = certified();
  lc.certification = { ...lc.certification!, revokedAt: new Date().toISOString(), revokedBy: 'ops-revoker' };
  return lc;
};

describe('LiveCertificationCard', () => {
  it("heading 'Live money certification' and testid live-certification-card", () => {
    const h = html();
    expect(h).toContain('Live money certification');
    expect(h).toContain('data-testid="live-certification-card"');
  });

  it("live-cert-state reads 'Not certified' / 'Certified' / 'Revoked', and stays 'Not certified' when readiness is 'error'", () => {
    expect(stateOf(html())).toBe('Not certified');
    expect(stateOf(html({ liveControls: certified() }))).toBe('Certified');
    expect(stateOf(html({ liveControls: revoked() }))).toBe('Revoked');
    expect(stateOf(html({ readiness: 'error' }))).toBe('Not certified');
    expect(stateOf(html({ liveControls: certified(), readiness: 'error' }))).toBe('Certified');
  });

  it("12 readiness lines in contract order; not-built lines read 'not built (PR8)' etc.", () => {
    const h = html();
    const ids = [...h.matchAll(/data-line="([a-z_]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual([...LIVE_READINESS_LINE_IDS]);
    for (const pr of ['PR8', 'PR9']) expect(h).toContain(`not built (${pr})`);
    expect((h.match(/not built \(/g) ?? []).length).toBe(4);
    expect(h).not.toContain('not built (PR4)');
    expect(h).not.toContain('not built (PR5)');
    expect(h).toContain('>pass<');
    expect(h).toContain('>fail<');
  });

  it('uncertified / certified (who, when) / revoked: the badge text and the right form', () => {
    const none = html();
    expect(none).toContain('data-testid="live-certify-form"');
    expect(none).not.toContain('data-testid="live-revoke-form"');
    const yes = html({ liveControls: certified() });
    expect(yes).toContain('by test-admin');
    expect(yes).toMatch(/Certified \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC by test-admin/);
    expect(yes).toContain('data-testid="live-revoke-form"');
    expect(yes).not.toContain('data-testid="live-certify-form"');
    const gone = html({ liveControls: revoked() });
    expect(gone).toContain('by ops-revoker');
    expect(gone).toContain('data-testid="live-certify-form"');
  });

  it('the contract shows the signed-on date and who recorded it, never the ref', () => {
    const lc = certified();
    lc.contract = { ...lc.contract!, ref: 'SECRET-MSA-REF-9' };
    const h = html({ liveControls: lc });
    expect(h).toContain(`Signed on ${lc.contract.signedOn}`);
    expect(h).toContain('recorded by test-admin');
    expect(h).not.toContain('SECRET-MSA-REF-9');
    expect(html()).toContain('No contract recorded.');
  });

  it('counsel refs are never rendered; the opt-in table shows yes/no per capability', () => {
    const lc = certified();
    lc.optIns.b2b = { ...lc.optIns.b2b!, counselRef: 'SECRET-COUNSEL-7' };
    lc.optIns.usdc = { counselRef: 'SECRET-COUNSEL-8', counselBy: 'ops-admin', counselAt: new Date().toISOString() };
    const h = html({ liveControls: lc });
    expect(h).not.toContain('SECRET-COUNSEL');
    const row = (cap: string) => new RegExp(`data-capability="${cap}"><td[^>]*>[^<]*</td><td[^>]*>(yes|no)</td><td>(yes|no)</td>`).exec(h)?.slice(1);
    expect(row('b2b')).toEqual(['yes', 'yes']);
    expect(row('usdc')).toEqual(['yes', 'no']);
    expect(row('schedules')).toEqual(['no', 'no']);
    expect(row('mcp')).toEqual(['no', 'no']);
    expect(row('telegram')).toEqual(['no', 'no']);
  });

  it("readiness 'error' -> 'The readiness checks could not be read.' in place of the lines", () => {
    const h = html({ readiness: 'error' });
    expect(h).toContain('The readiness checks could not be read.');
    expect(h).not.toContain('data-line=');
  });

  it('the certify form has reason and code fields; every form carries the code field', () => {
    const h = html();
    const certify = /data-testid="live-certify-form"[\s\S]*?<\/form>/.exec(h)?.[0] ?? '';
    expect(certify).toContain('name="reason"');
    expect(certify).toContain(`name="${STEP_UP_FIELD}"`);
    expect((h.match(new RegExp(`name="${STEP_UP_FIELD}"`, 'g')) ?? []).length).toBe(5); // certify, contract, counsel, clear, funding
    expect(h).toContain('name="signedOn"');
    expect(h).toContain('name="counselRef"');
    expect(h).toContain('name="clear" value="1"');
    expect(h).not.toContain('name="id"'); // the target is the bound route id, never a form field
    expect(h).not.toContain('name="partnerId"');
  });

  // Fix pack 5 T17 (P17): the stored funding mode (or 'none') and the funding-mode form.
  it("the card shows the stored funding mode (or 'none') and a funding-mode form with a mode select and the code field", () => {
    const fm = (h: string) => /data-testid="live-funding-mode"[^>]*>([\s\S]*?)<\/p>/.exec(h)?.[1].replace(/<!-- -->/g, '');
    expect(fm(html())).toBe('Funding mode: none');
    const lc = certified();
    expect(fm(html({ liveControls: { ...lc, fundingMode: { mode: 'partner_collected', setBy: 'ops-a', setAt: new Date().toISOString() } } }))).toMatch(
      /^Funding mode: Partner collects; set by ops-a on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\.$/,
    );
    expect(fm(html({ liveControls: { ...lc, fundingMode: { mode: 'partner_psp', setBy: 'ops-a', setAt: new Date().toISOString() } } }))).toMatch(
      /^Funding mode: Partner&#x27;s own Stripe account; set by ops-a/,
    );
    const f = /data-testid="live-funding-form"[\s\S]*?<\/form>/.exec(html())?.[0] ?? '';
    expect(f).toContain('<select name="mode"');
    expect(f).toContain('value="partner_collected"');
    expect(f).toContain('value="partner_psp"');
    expect(f).toContain('Partner collects the sender&#x27;s money');
    expect(f).toContain('Partner&#x27;s own Stripe account (needs Stripe funding and a restricted key)');
    expect(f).toContain(`name="${STEP_UP_FIELD}"`);
    expect(f).toContain('id="live-funding-code-acme"');
    expect(f).toContain('Save funding mode');
  });
});
