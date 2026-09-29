import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// UI redesign M3-21: the platform go-live card renders the M3-20 checklist (display only; the action
// re-checks) and offers "Approve" only for a requested, active partner whose steps 1-6 are done.
vi.mock('@/app/admin-dashboard/partners/go-live-actions', () => ({ approveGoLiveAction: async () => undefined }));

import { GoLiveCard, type GoLiveChecklistView } from '@/app/admin-dashboard/partners/go-live-card';
import type { OnboardingFacts } from '@/lib/partner-onboarding';
import type { GoLiveRecord } from '@/db/repos/partner-go-live-repo';

const allDone: OnboardingFacts = {
  whatsappOwnConfigured: true, whatsappTestOk: true, whatsappInboundSeen: true, templatesAttested: true,
  sandboxKeyActive: true, sandboxTransferDelivered: true, partnerRail: true, endpointUrlValid: true,
  recentPingOk: true, slugClaimed: true, logoSet: false, primaryColorSet: true,
  goLiveRequested: true, goLiveApproved: false, partnerActive: true,
};
const requested: GoLiveRecord = {
  partnerId: 'pa', requestedAt: new Date('2026-09-28T10:00:00Z'), requestedBy: 'pa-owner',
  approvedAt: null, approvedBy: null, updatedAt: new Date('2026-09-28T10:00:00Z'),
};
const view = (f: Partial<OnboardingFacts> = {}): GoLiveChecklistView => ({
  facts: { ...allDone, ...f },
  attestation: { actor: 'pa-owner', at: new Date('2026-09-27T09:00:00Z') },
});
const html = (o: Partial<Parameters<typeof GoLiveCard>[0]> = {}) =>
  renderToStaticMarkup(GoLiveCard({ partnerId: 'pa', partnerStatus: 'active', goLive: requested, checklist: view(), ...o }));

describe('GoLiveCard', () => {
  it('ready: the checklist, the attestation (who/when) and the Approve form', () => {
    const h = html();
    expect(h).toContain('Onboarding checklist');
    expect(h).toContain('Attested by pa-owner on 2026-09-27 09:00 UTC');
    expect(h).toContain('Inbound message received: yes');
    expect(h).toContain('Approve go-live');
    expect(h).toContain('name="id" value="pa"');
  });
  it('an incomplete step (e.g. no inbound message) → shown, and no Approve form', () => {
    const h = html({ checklist: view({ whatsappInboundSeen: false }) });
    expect(h).toContain('Inbound message received: no');
    expect(h).toContain('not done');
    expect(h).not.toContain('Approve go-live');
  });
  it('a partner that is not active → a clear reason, and no Approve form', () => {
    const h = html({ partnerStatus: 'suspended' });
    expect(h).toContain('Partner status: suspended');
    expect(h).toContain('reactivate it before approving');
    expect(h).not.toContain('Approve go-live');
  });
  it('not requested, already approved, or the checklist unreadable → no Approve form', () => {
    expect(html({ goLive: null })).not.toContain('Approve go-live');
    expect(html({ goLive: { ...requested, approvedAt: new Date(), approvedBy: 'root' } })).not.toContain('Approve go-live');
    const h = html({ checklist: 'error' });
    expect(h).toContain('could not be read');
    expect(h).not.toContain('Approve go-live');
  });
});
