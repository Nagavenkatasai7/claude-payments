import { describe, it, expect } from 'vitest';
import { KYC_TRAIL_ACTIONS, partnerKycTrail } from '@/lib/partner-kyc-trail';
import type { TenantAuditRow } from '@/lib/partner-audit-view';
import { t } from '@/lib/i18n';

// Lost-features p2 A9: one customer's KYC decision history on the partner page. Built from the
// durable audit rows only. The tenant's own decisions show the actor and the reason; SmartRemit's
// show "SmartRemit" and the outcome only (a platform reason can describe a screening hit).
const tenant = new Set(['pa-admin', 'pa-agent']);
let id = 0;
const row = (o: Partial<TenantAuditRow>): TenantAuditRow => ({
  id: ++id,
  at: new Date('2026-09-01T10:00:00.000Z'),
  actor: 'pa-admin',
  actorType: 'staff',
  action: 'kyc.review.approve',
  subjectId: 'cust:' + 'a'.repeat(64),
  meta: {},
  ...o,
});

describe('partnerKycTrail', () => {
  it('the action list is the five KYC decision slugs', () => {
    expect([...KYC_TRAIL_ACTIONS].sort()).toEqual(
      ['kyc.manual_override.approve', 'kyc.manual_override.create', 'kyc.manual_override.reject', 'kyc.review.approve', 'kyc.review.reject'].sort(),
    );
  });

  it('a platform row whose reason names a watchlist hit → "SmartRemit", outcome only, no reason text anywhere', () => {
    const out = partnerKycTrail(
      [row({ action: 'kyc.manual_override.reject', actor: 'owner-admin', meta: { reason: 'Watchlist match OFAC SDN entry', newStatus: 'rejected', actorScope: 'platform' } })],
      tenant,
      undefined,
    );
    expect(out).toEqual([{ at: '2026-09-01T10:00:00.000Z', actor: t('partner.audit.smartremit'), labelKey: 'partner.customers.trail.rejected', reason: null }]);
    expect(JSON.stringify(out)).not.toMatch(/Watchlist|OFAC|owner-admin/);
  });

  it('a partner-marked row → actor and reason', () => {
    const out = partnerKycTrail([row({ action: 'kyc.review.reject', actor: 'pa-agent', meta: { reason: 'Document photo unreadable', actorScope: 'partner' } })], tenant, undefined);
    expect(out[0]).toMatchObject({ actor: 'pa-agent', labelKey: 'partner.customers.trail.rejected', reason: 'Document photo unreadable' });
  });

  it('an unmarked row by a current tenant member keeps its reason; by a platform account or a stranger it is SmartRemit, no reason', () => {
    const out = partnerKycTrail(
      [
        row({ id: 1, actor: 'pa-admin', meta: { reason: 'Looked fine on review' } }),
        row({ id: 2, actor: 'owner-admin', meta: { reason: 'Platform note' } }),
        row({ id: 3, actor: 'someone-else', meta: { reason: 'Unknown note' } }),
        row({ id: 4, actor: 'pa-admin', meta: { reason: 'Marked platform', actorScope: 'platform' } }),
      ],
      tenant,
      undefined,
    );
    expect(out.map((e) => e.reason)).toEqual(['Looked fine on review', null, null, null]);
    expect(out.map((e) => e.actor)).toEqual(['pa-admin', ...Array(3).fill(t('partner.audit.smartremit'))]);
  });

  it('non-KYC actions never appear; a non-staff actor reads SmartRemit with no reason', () => {
    const out = partnerKycTrail(
      [row({ action: 'pii.view' }), row({ action: 'sanctions.screen' }), row({ actorType: 'system', meta: { reason: 'auto' } })],
      tenant,
      undefined,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ actor: t('partner.audit.smartremit'), reason: null });
  });

  it('a phone-shaped reason is masked', () => {
    const out = partnerKycTrail([row({ meta: { reason: 'Called 15551234567 back', actorScope: 'partner' } })], tenant, undefined);
    expect(out[0].reason).not.toContain('5551234567');
  });

  it('labels: approve, reject, created verified, created; oldest first with "Verification started" from kycSubmittedAt', () => {
    const out = partnerKycTrail(
      [
        row({ at: new Date('2026-09-03T00:00:00Z'), action: 'kyc.manual_override.approve', meta: { actorScope: 'partner' } }),
        row({ at: new Date('2026-09-02T00:00:00Z'), action: 'kyc.manual_override.create', meta: { newStatus: 'verified', actorScope: 'partner' } }),
        row({ at: new Date('2026-09-04T00:00:00Z'), action: 'kyc.manual_override.create', meta: { newStatus: 'grandfathered' } }),
      ],
      tenant,
      '2026-09-01T00:00:00.000Z',
    );
    expect(out.map((e) => e.labelKey)).toEqual([
      'partner.customers.trail.started',
      'partner.customers.trail.createdVerified',
      'partner.customers.trail.approved',
      'partner.customers.trail.created',
    ]);
    expect(out[0]).toMatchObject({ at: '2026-09-01T00:00:00.000Z', actor: null, reason: null });
  });

  it('an empty or junk reason is null', () => {
    const out = partnerKycTrail([row({ meta: { reason: '  ', actorScope: 'partner' } }), row({ meta: { reason: { x: 1 }, actorScope: 'partner' } })], tenant, undefined);
    expect(out.map((e) => e.reason)).toEqual([null, null]);
  });
});
