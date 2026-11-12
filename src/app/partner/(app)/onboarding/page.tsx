import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { CircleCheck, CircleDashed } from 'lucide-react';
import { requirePartnerStaff } from '@/lib/auth';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { getDb } from '@/db/client';
import { loadOnboardingFacts } from '@/db/repos/partner-onboarding-facts';
import { PING_FRESH_DAYS, computeOnboardingChecklist, mayRequestGoLive, onboardingStatus, type OnboardingFacts, type OnboardingState, type OnboardingStepKey } from '@/lib/partner-onboarding';
import { Badge, Card, PageHeader, type Tone } from '@/components/ds';
import { PARTNER_ROUTES, type PartnerRouteKey } from '../../routes';
import { getPartnerStore } from '@/lib/partner-store';
import type { KycDecider, PostureRecord } from '@/lib/live-controls';
import type { Partner } from '@/lib/types';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { AttestTemplatesForm, PostureForm, RequestGoLiveForm } from './onboarding-forms';

export const metadata: Metadata = {
  title: t('partner.onboarding.title'),
  robots: { index: false, follow: false },
};

// /partner/onboarding (UI redesign M3-20, SPEC §3.1): the seven-step go-live checklist. Admin only;
// the page gates itself (the layout's gate is chrome only) and reads the SESSION tenant's facts
// only. Every step is derived from stored facts (loadOnboardingFacts → computeOnboardingChecklist):
// there are no manual ticks, and the page renders booleans only (no secret, URL, phone number id or
// customer data). The two writes (template attestation, go-live request) are server actions that
// re-gate and re-compute server-side. Viewing writes nothing.
// Fix pack 3 T9 (R27): the compliance posture is a Card AFTER the steps list (never a step: no
// data-step; the seven steps are unchanged). It reads the session tenant's partner row on its own
// (a failure shows only this card's unavailable line) and renders labels, the signer's username
// and the date only: never a contract or counsel reference.

const STEP_LINK: Partial<Record<OnboardingStepKey, PartnerRouteKey>> = {
  whatsapp: 'integrationsWhatsapp',
  sandboxKey: 'integrationsApiKeys',
  sandboxTransfer: 'transfers',
  webhook: 'integrationsWebhooks',
  branding: 'branding',
};

const STATE_TONE: Record<OnboardingState, Tone> = {
  in_progress: 'neutral',
  ready: 'info',
  requested: 'warning',
  live: 'success',
};
const STATE_KEY: Record<OnboardingState, MessageKey> = {
  in_progress: 'partner.onboarding.state.in_progress',
  ready: 'partner.onboarding.state.ready',
  requested: 'partner.onboarding.state.requested',
  live: 'partner.onboarding.state.live',
};

const stepTitle = (k: OnboardingStepKey) => t(`partner.onboarding.step.${k}.title` as MessageKey);
const stepBody = (k: OnboardingStepKey) =>
  t(`partner.onboarding.step.${k}.body` as MessageKey, {
    days: PING_FRESH_DAYS,
  });

export default async function PartnerOnboardingPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.onboarding.policy);
  let facts: OnboardingFacts | null = null;
  try {
    facts = await loadOnboardingFacts(getDb(), ctx.partnerId);
  } catch (err) {
    logWarn('partner.onboarding.page', err instanceof Error ? err.name : 'error', { partnerId: ctx.partnerId });
  }

  const header = <PageHeader title={t('partner.onboarding.title')} sub={t('partner.onboarding.sub')} />;
  if (!facts) {
    return (
      <>
        {header}
        <Card as="section" className="p-5 sm:p-6">
          <p role="alert" className="text-[15px] leading-relaxed text-ds-ink">
            {t('partner.onboarding.unavailable')}
          </p>
        </Card>
      </>
    );
  }

  let partner: Partner | null = null;
  let partnerRead = true;
  try {
    partner = await getPartnerStore().getPartner(ctx.partnerId);
  } catch (err) {
    partnerRead = false;
    logWarn('partner.onboarding.posture-read', err instanceof Error ? err.name : 'error', { partnerId: ctx.partnerId });
  }

  const steps = computeOnboardingChecklist(facts);
  const status = onboardingStatus(facts);
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <>
      {header}
      <Card as="section" className="mb-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-3" data-testid="partner-onboarding-status">
          <Badge tone={STATE_TONE[status.state]}>{t(STATE_KEY[status.state])}</Badge>
          <span className="text-[14px] text-ds-ink-muted">
            {t('partner.onboarding.progress', {
              done: doneCount,
              total: steps.length,
            })}
          </span>
          {status.state === 'live' ? <p className="w-full text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.onboarding.liveNote')}</p> : null}
          {status.state === 'requested' ? <p className="w-full text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.onboarding.requestedNote')}</p> : null}
        </div>
      </Card>
      <ol className="flex flex-col gap-3" data-testid="partner-onboarding-steps" data-informational={status.informational ? 'true' : 'false'}>
        {steps.map((s) => {
          const link = STEP_LINK[s.key];
          const Icon = s.done ? CircleCheck : CircleDashed;
          return (
            <Card as="li" key={s.key} className="p-5 sm:p-6">
              <div className="flex items-start gap-3" data-step={s.step} data-done={s.done ? 'true' : 'false'}>
                <Icon aria-hidden="true" className={`mt-0.5 size-5 shrink-0 ${s.done ? 'text-ds-success-ink' : 'text-ds-ink-muted'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-ds-ink-muted">{t('partner.onboarding.stepLabel', { n: s.step })}</span>
                    <h2 className="text-[16px] font-semibold text-ds-ink">{stepTitle(s.key)}</h2>
                    <Badge tone={s.done ? 'success' : 'neutral'}>{t(s.done ? 'partner.onboarding.done' : 'partner.onboarding.todo')}</Badge>
                  </div>
                  <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{stepBody(s.key)}</p>
                  {link && !s.done ? (
                    <Link
                      href={PARTNER_ROUTES[link].href}
                      className="mt-2 inline-flex min-h-11 items-center rounded-ds-focus text-[14px] font-semibold text-ds-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ds-focus-ring"
                    >
                      {t('partner.onboarding.open')}
                    </Link>
                  ) : null}
                  {s.key === 'templates' ? s.done ? <p className="mt-2 text-[14px] text-ds-ink">{t('partner.onboarding.attest.done')}</p> : <AttestTemplatesForm /> : null}
                  {s.key === 'goLive' && !s.done && !status.informational ? <RequestGoLiveForm ready={mayRequestGoLive(facts)} /> : null}
                </div>
              </div>
            </Card>
          );
        })}
      </ol>
      <PostureCard partner={partnerRead ? partner : undefined} />
    </>
  );
}

const KYC_LABEL: Record<KycDecider, MessageKey> = {
  partner: 'partner.live.posture.kycDecider.partner',
  smartremit_procedures: 'partner.live.posture.kycDecider.smartremit_procedures',
};
const HOLD_LABEL: Record<PostureRecord['holdDecider'], MessageKey> = {
  partner: 'partner.live.posture.holdDecider.partner',
  smartremit_delegated: 'partner.live.posture.holdDecider.smartremit_delegated',
};

/** `partner` undefined = the read failed; null = no row (nothing to sign against). */
function PostureCard({ partner }: { partner: Partner | null | undefined }) {
  const posture = partner?.liveControls?.posture;
  let body: ReactNode;
  if (!partner) {
    body = (
      <p role="alert" className="mt-2 text-[14px] leading-relaxed text-ds-ink">
        {t(partner === undefined ? 'partner.live.posture.unavailable' : 'partner.onboarding.failed')}
      </p>
    );
  } else if (partner.id === DEFAULT_PARTNER_ID) {
    // Pack 3 review Q1 (H1): SmartRemit's own default tenant never signs a posture (the action and
    // the writer refuse it too), so no form is rendered.
    body = <p className="mt-2 text-[14px] leading-relaxed text-ds-ink">{t('partner.live.posture.defaultTenant')}</p>;
  } else if (posture) {
    body = (
      <div className="mt-2 flex flex-col gap-2 text-[14px] leading-relaxed text-ds-ink">
        <p>{t('partner.live.posture.signed', { who: posture.signedBy, date: posture.signedAt.slice(0, 10) })}</p>
        <dl className="grid gap-1 sm:grid-cols-[auto_1fr] sm:gap-x-4">
          <dt className="font-semibold">{t('partner.live.posture.kycDecider')}</dt>
          <dd>{t(KYC_LABEL[posture.kycDecider])}</dd>
          <dt className="font-semibold">{t('partner.live.posture.holdDecider')}</dt>
          <dd>{t(HOLD_LABEL[posture.holdDecider])}</dd>
        </dl>
        {/* P31 (pack 7): the posture answers route and are enforced once the partner is live-certified (holdDecider routes holds; fourEyes is enforced in a queue partner's hold queue). */}
        <p className="text-ds-ink-muted">{t('partner.live.posture.holdDecider.recorded')}</p>
        {posture.fourEyesNonSanctions ? (
          <p>{t(posture.holdDecider === 'smartremit_delegated' ? 'partner.live.posture.fourEyes.signedDelegated' : 'partner.live.posture.fourEyes.signed')}</p>
        ) : null}
        <p className="text-ds-ink-muted">{t('partner.live.posture.forcedNote')}</p>
      </div>
    );
  } else {
    body = <PostureForm expected={partner.kycMode === 'delegated' ? 'partner' : 'smartremit_procedures'} />;
  }
  return (
    <Card as="section" className="mt-4 p-5 sm:p-6">
      <div data-testid="partner-live-posture">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[16px] font-semibold text-ds-ink">{t('partner.live.posture.title')}</h2>
          {posture && partner?.id !== DEFAULT_PARTNER_ID ? <Badge tone="success">{t('partner.onboarding.done')}</Badge> : null}
        </div>
        <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.live.posture.sub')}</p>
        {body}
      </div>
    </Card>
  );
}
