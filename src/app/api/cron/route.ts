import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getStore } from '@/lib/store';
import { getScheduleStore } from '@/lib/schedule-store';
import { runDueSchedules } from '@/lib/cron-run';
import {
  sendTemplate,
  SCHEDULED_TEMPLATE_NAME,
  RECIPIENT_TEMPLATE_LANG,
} from '@/lib/whatsapp';

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  // When CRON_SECRET is configured, Vercel sends it as a Bearer token.
  if (env.cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${env.cronSecret}`) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const result = await runDueSchedules({
    store: getStore(),
    scheduleStore: getScheduleStore(),
    now: Date.now(),
    sendScheduledLink: async (schedule, _transfer, url) => {
      try {
        await sendTemplate(
          schedule.phone,
          SCHEDULED_TEMPLATE_NAME,
          RECIPIENT_TEMPLATE_LANG,
          [
            `$${schedule.amountUsd.toFixed(2)}`,
            schedule.recipientName,
            url,
          ],
        );
      } catch (err) {
        console.error('Scheduled-link send failed:', schedule.id, err);
      }
    },
  });

  return NextResponse.json({ ok: true, fired: result.fired });
}
