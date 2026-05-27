import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getStore } from '@/lib/store';
import { getScheduleStore } from '@/lib/schedule-store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { runDueSchedules } from '@/lib/cron-run';
import { backfillCustomersOnce, backfillCountryCurrencyOnce, backfillPartnersOnce } from '@/lib/migration';
import { sendText } from '@/lib/whatsapp';

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

  // Idempotent backfills — sentinel-guarded.
  const backfill = await backfillCustomersOnce(store, customerStore);
  const countryCurrencyBackfill = await backfillCountryCurrencyOnce(store, customerStore);
  const partnerBackfill = await backfillPartnersOnce(store, customerStore, partnerStore);

  const result = await runDueSchedules({
    store,
    scheduleStore: getScheduleStore(),
    now: Date.now(),
    sendScheduledLink: async (schedule, _transfer, url) => {
      // TEMPORARY: the scheduled_payment_ready template is not yet approved
      // by Meta. Until it is, fall back to a free-form WhatsApp text. This
      // only delivers if the customer chatted with the bot within the last
      // 24 hours; otherwise WhatsApp rejects it with a re-engagement error,
      // which is logged and swallowed. Switch back to `sendTemplate` once
      // the template is approved.
      const text =
        `Your scheduled SendHome transfer of $${schedule.amountUsd.toFixed(2)} ` +
        `to ${schedule.recipientName} is ready. Tap to pay: ${url}`;
      try {
        await sendText(schedule.phone, text);
      } catch (err) {
        console.error('Scheduled-link send failed:', schedule.id, err);
      }
    },
  });

  return NextResponse.json({
    ok: true,
    fired: result.fired,
    backfill,
    countryCurrencyBackfill,
    partnerBackfill,          // NEW (P2)
  });
}
