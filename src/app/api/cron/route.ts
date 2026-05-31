import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getStore } from '@/lib/store';
import { getScheduleStore } from '@/lib/schedule-store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { runDueSchedules } from '@/lib/cron-run';
import {
  backfillCustomersOnce,
  backfillCountryCurrencyOnce,
  backfillPartnersOnce,
  backfillSchedulesOnce,
  backfillSourceAmountsOnce,
  backfillCorridorComplianceOnce,
  backfillExpandCountriesOnce,
  backfillAllCorridorsOnce,
} from '@/lib/migration';
import { sendTemplateWithButton, sendTemplateOrText } from '@/lib/whatsapp';
import {
  TEMPLATE_SCHEDULED_PAYMENT_READY,
  TEMPLATE_LANG,
  scheduledPaymentReadyParams,
} from '@/lib/whatsapp-templates';

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  // When CRON_SECRET is configured, Vercel sends it as a Bearer token.
  if (env.cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${env.cronSecret}`) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const store = getStore();
  const customerStore = getCustomerStore(store);
  const partnerStore = getPartnerStore();
  const monthlyVolumeStore = getMonthlyVolumeStore();
  const scheduleStore = getScheduleStore();

  // Idempotent backfills — sentinel-guarded.
  const backfill = await backfillCustomersOnce(store, customerStore);
  const countryCurrencyBackfill = await backfillCountryCurrencyOnce(store, customerStore);
  const partnerBackfill = await backfillPartnersOnce(store, customerStore, partnerStore);
  const schedulePartnerBackfill = await backfillSchedulesOnce(store, scheduleStore);
  const sourceAmountBackfill = await backfillSourceAmountsOnce(store, scheduleStore); // NEW (P4)
  const corridorComplianceBackfill = await backfillCorridorComplianceOnce(store, partnerStore); // NEW (P5)
  const expandCountriesBackfill = await backfillExpandCountriesOnce(store, partnerStore); // NEW (multicountry)
  const allCorridorsBackfill = await backfillAllCorridorsOnce(store, partnerStore); // NEW (any-to-any)

  const result = await runDueSchedules({
    store,
    partnerStore,                 // NEW (P5): corridor-aware compliance
    customerStore,                // NEW (Item 4): skip opted-out customers
    monthlyVolumeStore,           // NEW (KYC): cumulative-month EDD trigger at run time
    scheduleStore,
    now: Date.now(),
    sendScheduledLink: async (schedule, transfer, url) => {
      // The scheduled_payment_ready template (docs §3.3) path is now wired, but
      // the template is not yet approved by Meta. Until it is, sendTemplateOrText
      // tries the template send, the Graph API rejects it (template not found),
      // and we fall back to the SAME free-form text we sent before — byte-for-byte
      // unchanged, so there is no observable drift until the template goes live.
      // The free-form fallback only delivers in-window; otherwise WhatsApp rejects
      // it with a re-engagement error, which the helper logs and swallows.
      const senderName = (await customerStore.getCustomer(schedule.phone))?.fullName ?? 'there';
      const fallbackText =
        `Your scheduled SmartRemit transfer of $${schedule.amountUsd.toFixed(2)} ` +
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
          ),
        fallbackText,
      );
    },
  });

  return NextResponse.json({
    ok: true,
    fired: result.fired,
    backfill,
    countryCurrencyBackfill,
    partnerBackfill,          // NEW (P2)
    schedulePartnerBackfill,  // NEW (P3)
    sourceAmountBackfill,     // NEW (P4)
    corridorComplianceBackfill,  // NEW (P5)
    expandCountriesBackfill,     // NEW (multicountry)
    allCorridorsBackfill,        // NEW (any-to-any)
  });
}
