/**
 * Fix pack 7 T28 (P25 partner trail, P22 trail half): the KYC "Decision history" of a partner that
 * DECIDES KYC adds two opt-in row kinds for its qualified compliance users only: SmartRemit's
 * recommendation (kyc.recommend: outcome + SmartRemit's reason, never the SmartRemit username) and
 * the team's own PEP clear (customer.screening_hold.clear marked actorScope 'partner'). Without the
 * options the output equals today's for any input; KYC_TRAIL_ACTIONS stays the five pinned slugs.
 */
import { describe, it, expect } from 'vitest';
import { KYC_TRAIL_ACTIONS, KYC_TRAIL_READ_ACTIONS, partnerKycTrail } from '@/lib/partner-kyc-trail';
import { safeText, type TenantAuditRow } from '@/lib/partner-audit-view';
import { t, type MessageKey } from '@/lib/i18n';

const tenant = new Set(['pa-admin', 'co-a']);
const HOUR = 3_600_000;
const base = Date.now() - 48 * HOUR;
const at = (h: number) => new Date(base + h * HOUR);
let id = 0;
const row = (o: Partial<TenantAuditRow>): TenantAuditRow => ({
  id: ++id,
  at: at(0),
  actor: 'pa-admin',
  actorType: 'staff',
  action: 'kyc.review.approve',
  subjectId: 'cust:' + 'a'.repeat(64),
  meta: {},
  ...o,
});
const REC_REASON = 'Documents and the selfie match; low risk corridor.';
const recommend = (o: Partial<TenantAuditRow> = {}, meta: Record<string, unknown> = {}) =>
  row({ action: 'kyc.recommend', actor: 'owner-admin', meta: { recommendation: 'approve', reason: REC_REASON, ...meta }, ...o });
const pepClear = (meta: Record<string, unknown> = {}, o: Partial<TenantAuditRow> = {}) =>
  row({
    action: 'customer.screening_hold.clear',
    actor: 'co-a',
    meta: { pepHit: true, watchlistHit: false, actorScope: 'partner', via: 'kyc_decision', kycStatus: 'verified', ...meta },
    ...o,
  });
const BOTH = { recommendations: true, pepClears: true };

describe('partnerKycTrail for a partner that decides KYC (T28)', () => {
  it('1. KYC_TRAIL_READ_ACTIONS equals KYC_TRAIL_ACTIONS plus kyc.recommend and customer.screening_hold.clear; KYC_TRAIL_ACTIONS is still the five slugs', () => {
    expect([...KYC_TRAIL_READ_ACTIONS]).toEqual([...KYC_TRAIL_ACTIONS, 'kyc.recommend', 'customer.screening_hold.clear']);
    expect(Object.isFrozen(KYC_TRAIL_READ_ACTIONS)).toBe(true);
    expect([...KYC_TRAIL_ACTIONS].sort()).toEqual(
      ['kyc.manual_override.approve', 'kyc.manual_override.create', 'kyc.manual_override.reject', 'kyc.review.approve', 'kyc.review.reject'].sort(),
    );
  });

  it('2. without opts: a kyc.recommend row and a partner-scope clear row are dropped (output equals today)', () => {
    const decision = row({ meta: { actorScope: 'partner', reason: 'Fine' } });
    const today = partnerKycTrail([decision], tenant, undefined);
    expect(partnerKycTrail([recommend(), pepClear(), decision], tenant, undefined)).toEqual(today);
    expect(partnerKycTrail([recommend(), pepClear(), decision], tenant, undefined, {})).toEqual(today);
    expect(partnerKycTrail([recommend()], tenant, undefined, { pepClears: true })).toEqual([]);
    expect(partnerKycTrail([pepClear()], tenant, undefined, { recommendations: true })).toEqual([]);
  });

  it('3. { recommendations: true }: approve and reject labels, SmartRemit actor, masked reason; no SmartRemit username', () => {
    const out = partnerKycTrail(
      [recommend({ at: at(1) }), recommend({ at: at(2) }, { recommendation: 'reject', reason: '  Address could not be confirmed.  ' })],
      tenant,
      undefined,
      { recommendations: true },
    );
    expect(out).toEqual([
      { at: at(1).toISOString(), actor: t('partner.audit.smartremit'), labelKey: 'partner.customers.trail.recommendApprove', reason: safeText(REC_REASON) },
      { at: at(2).toISOString(), actor: t('partner.audit.smartremit'), labelKey: 'partner.customers.trail.recommendReject', reason: 'Address could not be confirmed.' },
    ]);
    expect(JSON.stringify(out)).not.toContain('owner-admin');
  });

  it('4. kyc.recommend with an unknown recommendation, a non-string or empty reason, or a non-staff actor -> dropped', () => {
    const out = partnerKycTrail(
      [
        recommend({}, { recommendation: 'escalate' }),
        recommend({}, { recommendation: undefined }),
        recommend({}, { reason: 42 }),
        recommend({}, { reason: '   ' }),
        recommend({ actorType: 'system' }),
        recommend({ actorType: 'api_key' }),
        recommend({ meta: null }),
      ],
      tenant,
      undefined,
      BOTH,
    );
    expect(out).toEqual([]);
  });

  it('5. a phone-shaped run in a recommendation reason is masked', () => {
    const out = partnerKycTrail([recommend({}, { reason: 'Called 15551234567 back' })], tenant, undefined, { recommendations: true });
    expect(out).toHaveLength(1);
    expect(out[0].reason).not.toContain('5551234567');
  });

  it('6. { pepClears: true }: a partner-scope staff clear shows the actor, no reason; other clears are dropped', () => {
    const out = partnerKycTrail([pepClear({ reason: 'never shown' })], tenant, undefined, { pepClears: true });
    expect(out).toEqual([{ at: at(0).toISOString(), actor: safeText('co-a'), labelKey: 'partner.customers.trail.pepCleared', reason: null }]);
    const dropped = partnerKycTrail(
      [
        pepClear({ actorScope: undefined }),
        pepClear({ actorScope: 'platform' }),
        pepClear({ watchlistHit: true }),
        pepClear({}, { actorType: 'system' }),
      ],
      tenant,
      undefined,
      BOTH,
    );
    expect(dropped).toEqual([]);
  });

  it('7. ordering: recommend, clear and decision rows interleave by time; ties by id', () => {
    const r1 = recommend({ at: at(1) });
    const c1 = pepClear({}, { at: at(2) });
    const d1 = row({ at: at(2), action: 'kyc.review.approve', actor: 'co-a', meta: { actorScope: 'partner', reason: 'EDD done' } });
    const r0 = recommend({ at: at(0.5) }, { recommendation: 'reject' });
    const out = partnerKycTrail([d1, c1, r1, r0], tenant, at(0).toISOString(), BOTH);
    const keys = out.map((e) => e.labelKey.slice('partner.customers.trail.'.length));
    expect(keys).toEqual(['started', 'recommendReject', 'recommendApprove', 'pepCleared', 'approved']);
  });

  it('8. en.ts has the new keys, none empty', () => {
    const keys: MessageKey[] = [
      'partner.customers.trail.recommendApprove',
      'partner.customers.trail.recommendReject',
      'partner.customers.trail.pepCleared',
      'partner.customers.trail.noteDecides',
      'partner.reviews.kyc.subPartnerDecides',
    ];
    for (const k of keys) {
      expect(t(k)).not.toBe(k);
      expect(t(k).trim()).not.toBe('');
    }
    expect(t('partner.reviews.kyc.subPartnerDecides')).not.toMatch(/sanction|OFAC|watchlist|list/i);
  });
});
