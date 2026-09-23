import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { bearerMatches } from '@/lib/cron-auth';
import { getStore } from '@/lib/store';
import { getScheduleStore } from '@/lib/schedule-store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { runDueSchedules } from '@/lib/cron-run';
import { expireUnpaidLinks } from '@/lib/stale-money';
import { logError } from '@/lib/log';
import { getDb } from '@/db/client';
import { getKycProvider } from '@/lib/providers/kyc-provider';
import { sendTemplateWithButton, sendTemplateOrText, sendVerificationStatus, type WaCreds } from '@/lib/whatsapp';
import {
  TEMPLATE_SCHEDULED_PAYMENT_READY,
  TEMPLATE_LANG,
  scheduledPaymentReadyParams,
} from '@/lib/whatsapp-templates';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { resolvePartnerBranding } from '@/lib/partner-config';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import type { PartnerId } from '@/lib/types';

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  // When CRON_SECRET is configured, Vercel sends it as a Bearer token.
  // Constant-time, fail-closed (src/lib/cron-auth.ts).
  if (env.cronSecret && !bearerMatches(req.headers.get('authorization'), env.cronSecret)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const store = getStore();
  const customerStore = getCustomerStore(store);
  const partnerStore = getPartnerStore();
  const monthlyVolumeStore = getMonthlyVolumeStore();
  const scheduleStore = getScheduleStore();

  // (The one-shot Redis-era backfills are gone — the Postgres ledger is born
  // complete; schema changes ship as drizzle migrations now.)
  const kycProvider = getKycProvider(customerStore, env.appBaseUrl);

  // WL2: scheduled notifications carry the OWNING partner's brand and leave from
  // the partner's number. Default/unconfigured ⇒ SmartRemit + env number.
  const partnerSendContext = async (
    partnerId: PartnerId,
  ): Promise<{ brand: string; waCreds?: WaCreds }> => {
    const partner = await partnerStore.getPartner(partnerId);
    const integrations = await getPartnerIntegrationsStore().getIntegrations(partnerId);
    return { brand: resolvePartnerBranding(partner).brand, waCreds: waCredsFrom(integrations) };
  };

  const result = await runDueSchedules({
    db: getDb(),                  // Task 9: a refused run enqueues a deduped ops alert
    store,
    partnerStore,                 // NEW (P5): corridor-aware compliance
    customerStore,                // NEW (Item 4): skip opted-out customers
    monthlyVolumeStore,           // NEW (KYC): cumulative-month EDD trigger at run time
    scheduleStore,
    kycProvider,                  // NEW (Phase 3): verify-before-send hand-off url
    now: Date.now(),
    // NEW (Phase 3) — fail-soft nudge when a scheduled send is skipped pending KYC.
    sendScheduledSkipped: async (schedule, owner, kycUrl) => {
      const { brand, waCreds } = await partnerSendContext(schedule.partnerId);
      await sendTemplateOrText(
        schedule.phone,
        () => sendVerificationStatus(schedule.phone, 'needed', owner?.fullName),
        `Verify your identity to resume your scheduled ${brand} transfer: ${kycUrl}`,
        waCreds,
      );
    },
    sendScheduledLink: async (schedule, transfer, url) => {
      // The scheduled_payment_ready template (docs §3.3) path is now wired, but
      // the template is not yet approved by Meta. Until it is, sendTemplateOrText
      // tries the template send, the Graph API rejects it (template not found),
      // and we fall back to the SAME free-form text we sent before — byte-for-byte
      // unchanged, so there is no observable drift until the template goes live.
      // The free-form fallback only delivers in-window; otherwise WhatsApp rejects
      // it with a re-engagement error, which the helper logs and swallows.
      const senderName = (await customerStore.getCustomer(schedule.partnerId, schedule.phone))?.fullName ?? 'there';
      const { brand, waCreds } = await partnerSendContext(schedule.partnerId);
      const fallbackText =
        `Your scheduled ${brand} transfer of $${schedule.amountUsd.toFixed(2)} ` +
        `to ${schedule.recipientName} is ready. Tap to pay: ${url}`;
      const { bodyParams, buttonToken } = scheduledPaymentReadyParams(
        schedule,
        transfer.id,
        senderName,
      );
      await sendTemplateOrText(
        schedule.phone,
        () =>
          sendTemplateWithButton(
            schedule.phone,
            TEMPLATE_SCHEDULED_PAYMENT_READY,
            TEMPLATE_LANG,
            bodyParams,
            buttonToken,
            waCreds,
          ),
        fallbackText,
        waCreds,
      );
    },
  });

  // Program-Fix 32 (neon-09): expire unfunded pay links older than 7 days
  // (guarded cancel + audit row per link; never a charged row, never a customer
  // message). Runs AFTER the schedules and fail-soft: a throw never costs the
  // schedule result. `expired` is null when the sweep failed (logged).
  let expired: number | null = null;
  try {
    expired = await expireUnpaidLinks(getDb());
  } catch (err) {
    logError('cron.expire-links', err);
  }

  return NextResponse.json({ ok: true, fired: result.fired, failed: result.failed, expired });
}
