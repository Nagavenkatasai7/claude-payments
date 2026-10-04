import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_STEP_KEYS,
  computeOnboardingChecklist,
  goLivePrerequisitesDone,
  mayRequestGoLive,
  onboardingStatus,
  type OnboardingFacts,
} from '@/lib/partner-onboarding';

// UI redesign M3-20 (SPEC §3.1): the seven-step onboarding checklist, derived ONLY from stored
// facts (no manual ticks). One test per step, done and not done; a backfilled approved partner is
// Live and the checklist becomes informational.

const COMPLETE: OnboardingFacts = Object.freeze({
  whatsappOwnConfigured: true,
  whatsappTestOk: true,
  whatsappInboundSeen: true,
  templatesAttested: true,
  sandboxKeyActive: true,
  sandboxTransferDelivered: true,
  partnerRail: true,
  endpointUrlValid: true,
  recentPingOk: true,
  slugClaimed: true,
  logoSet: false,
  primaryColorSet: true,
  goLiveRequested: false,
  goLiveApproved: false,
  partnerActive: true,
});
const facts = (o: Partial<OnboardingFacts> = {}): OnboardingFacts => ({ ...COMPLETE, ...o });
const done = (f: OnboardingFacts, step: number) => computeOnboardingChecklist(f).find((s) => s.step === step)!.done;

describe('computeOnboardingChecklist: the shape', () => {
  it('returns exactly the seven steps, in order, with stable keys', () => {
    const steps = computeOnboardingChecklist(facts());
    expect(steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(steps.map((s) => s.key)).toEqual([...ONBOARDING_STEP_KEYS]);
    expect(ONBOARDING_STEP_KEYS).toEqual(['whatsapp', 'templates', 'sandboxKey', 'sandboxTransfer', 'webhook', 'branding', 'goLive']);
  });
});

describe('step 1: WhatsApp connected + webhook verified', () => {
  it('done when the own number is configured, the last test passed and an inbound message was seen', () => {
    expect(done(facts(), 1)).toBe(true);
  });
  it.each(['whatsappOwnConfigured', 'whatsappTestOk', 'whatsappInboundSeen'] as const)('not done without %s', (k) => {
    expect(done(facts({ [k]: false }), 1)).toBe(false);
  });
});

describe('step 2: templates approved (attested)', () => {
  it('done when attested', () => expect(done(facts(), 2)).toBe(true));
  it('not done without the attestation', () => expect(done(facts({ templatesAttested: false }), 2)).toBe(false));
});

describe('step 3: sandbox API key', () => {
  it('done with an unrevoked sandbox key', () => expect(done(facts(), 3)).toBe(true));
  it('not done without one', () => expect(done(facts({ sandboxKeyActive: false }), 3)).toBe(false));
});

describe('step 4: sandbox test transfer end-to-end', () => {
  it('done with a delivered sandbox transfer', () => expect(done(facts(), 4)).toBe(true));
  it('not done without one', () => expect(done(facts({ sandboxTransferDelivered: false }), 4)).toBe(false));
});

describe('step 5: webhook endpoint + test event delivered', () => {
  it('done with a partner rail, a valid endpoint and a recent ok ping', () => expect(done(facts(), 5)).toBe(true));
  it.each(['partnerRail', 'endpointUrlValid', 'recentPingOk'] as const)('not done without %s', (k) => {
    expect(done(facts({ [k]: false }), 5)).toBe(false);
  });
});

describe('step 6: branding + slug', () => {
  it('done with a slug and a validated primary colour', () => expect(done(facts(), 6)).toBe(true));
  it('done with a slug and a logo (no colour)', () => expect(done(facts({ primaryColorSet: false, logoSet: true }), 6)).toBe(true));
  it('not done without a slug', () => expect(done(facts({ slugClaimed: false, logoSet: true }), 6)).toBe(false));
  // 2026-10-04: pages are SmartRemit-branded, so a partner logo or colour is no longer needed to go live.
  it('done with a slug alone (no logo, no colour)', () => expect(done(facts({ primaryColorSet: false, logoSet: false }), 6)).toBe(true));
});

describe('step 7: request go-live', () => {
  it('not done before a request', () => expect(done(facts(), 7)).toBe(false));
  it('done once requested', () => expect(done(facts({ goLiveRequested: true }), 7)).toBe(true));
  it('done when approved without a request row (the 0028 backfill)', () => expect(done(facts({ goLiveApproved: true }), 7)).toBe(true));
});

describe('prerequisites and the request rule', () => {
  it('steps 1–6 all done → prerequisites met, and a request is allowed', () => {
    expect(goLivePrerequisitesDone(computeOnboardingChecklist(facts()))).toBe(true);
    expect(mayRequestGoLive(facts())).toBe(true);
  });
  it('any one of steps 1–6 missing → no request', () => {
    for (const k of ['whatsappInboundSeen', 'templatesAttested', 'sandboxKeyActive', 'sandboxTransferDelivered', 'recentPingOk', 'slugClaimed'] as const) {
      expect(mayRequestGoLive(facts({ [k]: false })), k).toBe(false);
    }
  });
  it('already requested or already approved → no (second) request', () => {
    expect(mayRequestGoLive(facts({ goLiveRequested: true }))).toBe(false);
    expect(mayRequestGoLive(facts({ goLiveApproved: true }))).toBe(false);
  });
  it('step 7 never counts as a prerequisite of itself', () => {
    const steps = computeOnboardingChecklist(facts());
    expect(steps[6].done).toBe(false);
    expect(goLivePrerequisitesDone(steps)).toBe(true);
  });
});

describe('onboardingStatus', () => {
  it('in progress while any prerequisite is missing', () => {
    expect(onboardingStatus(facts({ sandboxKeyActive: false }))).toEqual({ state: 'in_progress', informational: false });
  });
  it('ready once 1–6 are done and nothing is requested', () => {
    expect(onboardingStatus(facts())).toEqual({ state: 'ready', informational: false });
  });
  it('requested after the request, until SmartRemit approves', () => {
    expect(onboardingStatus(facts({ goLiveRequested: true }))).toEqual({ state: 'requested', informational: false });
  });
  it('a backfilled approved partner with nothing else done is Live and the checklist is informational', () => {
    const none: OnboardingFacts = Object.fromEntries(Object.keys(COMPLETE).map((k) => [k, false])) as unknown as OnboardingFacts;
    const backfilled = { ...none, goLiveApproved: true, partnerActive: true };
    expect(onboardingStatus(backfilled)).toEqual({ state: 'live', informational: true });
    expect(computeOnboardingChecklist(backfilled)[6].done).toBe(true);
    expect(mayRequestGoLive(backfilled)).toBe(false);
  });
  it('approval alone is never "live": the partner must also be active (#409 L1)', () => {
    expect(onboardingStatus(facts({ goLiveApproved: true, partnerActive: false })).state).not.toBe('live');
  });
});
