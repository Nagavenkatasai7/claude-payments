// partner-onboarding (UI redesign M3-20, SPEC §3.1): the PURE seven-step go-live checklist. Every
// step is DERIVED from stored facts (loadOnboardingFacts, src/db/repos/partner-onboarding-facts.ts);
// there are no manual ticks. The page, the request action and the platform approval card (M3-21)
// all use these functions, so the three can never disagree about what "done" means.
//
// Live = go-live approved AND the partner is active (PR 409 review L1: the 0028 backfill approved every
// partner that existed, including suspended/test ones, so approval alone is never "live"). A
// backfilled partner has approved_at without requested_at: step 7 counts as done, and the
// checklist becomes informational.

/** The facts the checklist is computed from. Booleans only: no secret, URL or identifier. */
export interface OnboardingFacts {
  /** Own WhatsApp number: phone number id + access token + app secret all stored. */
  whatsappOwnConfigured: boolean;
  /** The last "Test connection" result is ok. */
  whatsappTestOk: boolean;
  /** At least one inbound WhatsApp message was received for this partner (Meta reaches our webhook). */
  whatsappInboundSeen: boolean;
  /** A partner admin attested both templates are approved (audit partner.templates.attest). */
  templatesAttested: boolean;
  /** An unrevoked sandbox (test) API key exists. */
  sandboxKeyActive: boolean;
  /** A sandbox (environment 'test') transfer reached 'delivered'. */
  sandboxTransferDelivered: boolean;
  /** The settlement rail is partner-operated (providerType 'http'). */
  partnerRail: boolean;
  /** The stored settlement URL passes the partner-surface URL rule. */
  endpointUrlValid: boolean;
  /** A test ping with outcome 'ok' in the last PING_FRESH_DAYS days. */
  recentPingOk: boolean;
  slugClaimed: boolean;
  /** A stored logo that is renderable (renderableLogoSrc). */
  logoSet: boolean;
  /** A primary colour that passes validateThemeColor. */
  primaryColorSet: boolean;
  goLiveRequested: boolean;
  goLiveApproved: boolean;
  /** partners.status === 'active'. */
  partnerActive: boolean;
}

/** Step 2: the WhatsApp templates a partner admin attests are approved (plan O9). */
export const ATTESTED_TEMPLATES = Object.freeze(['authentication', 'transfer_delivered'] as const);

/** How recent a successful test ping must be to count for step 5. */
export const PING_FRESH_DAYS = 30;

export const ONBOARDING_STEP_KEYS = Object.freeze(['whatsapp', 'templates', 'sandboxKey', 'sandboxTransfer', 'webhook', 'branding', 'goLive'] as const);
export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];
export type OnboardingStepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface OnboardingStep {
  step: OnboardingStepNumber;
  key: OnboardingStepKey;
  done: boolean;
}

export function computeOnboardingChecklist(f: OnboardingFacts): OnboardingStep[] {
  const done: Record<OnboardingStepKey, boolean> = {
    whatsapp: f.whatsappOwnConfigured && f.whatsappTestOk && f.whatsappInboundSeen,
    templates: f.templatesAttested,
    sandboxKey: f.sandboxKeyActive,
    sandboxTransfer: f.sandboxTransferDelivered,
    webhook: f.partnerRail && f.endpointUrlValid && f.recentPingOk,
    branding: f.slugClaimed && (f.logoSet || f.primaryColorSet),
    goLive: f.goLiveRequested || f.goLiveApproved,
  };
  return ONBOARDING_STEP_KEYS.map((key, i) => ({ step: (i + 1) as OnboardingStepNumber, key, done: done[key] }));
}

/** Steps 1–6 (everything a go-live request needs); step 7 is the request itself. */
export function goLivePrerequisitesDone(steps: readonly OnboardingStep[]): boolean {
  const prereqs = steps.filter((s) => s.step <= 6);
  return prereqs.length === 6 && prereqs.every((s) => s.done);
}

/** A (first) go-live request is allowed: 1–6 done, and nothing requested or approved yet. */
export function mayRequestGoLive(f: OnboardingFacts): boolean {
  return !f.goLiveRequested && !f.goLiveApproved && goLivePrerequisitesDone(computeOnboardingChecklist(f));
}

export type OnboardingState = 'in_progress' | 'ready' | 'requested' | 'live';

export function onboardingStatus(f: OnboardingFacts): { state: OnboardingState; informational: boolean } {
  if (f.goLiveApproved && f.partnerActive) return { state: 'live', informational: true };
  // Approved but not active waits on SmartRemit, exactly like a pending request.
  if (f.goLiveRequested || f.goLiveApproved) return { state: 'requested', informational: false };
  return { state: goLivePrerequisitesDone(computeOnboardingChecklist(f)) ? 'ready' : 'in_progress', informational: false };
}
