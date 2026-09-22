/**
 * OWNER-RUN, REVIEWED remediation (fix 6 / ctx-01). Before fix 6, create_schedule
 * stored whatever payout destination the model supplied; a model invention
 * (e.g. "xxxx9012") is indistinguishable from a real account, so EVERY active
 * schedule created before the fix deploy that holds a destination is blanked to
 * '' / 'bank' — each run then collects the account on the secure pay page.
 *
 * DRY RUN by default — prints the count and schedule ids only:
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/blank-prefix-schedule-destinations.ts --before <fix deploy ISO>
 * Apply ONLY after the owner reviewed the dry-run count:
 *   … scripts/blank-prefix-schedule-destinations.ts --before <fix deploy ISO> --apply
 */
import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { getDb, type DbOrTx } from '@/db/client';
import { schedules } from '@/db/schema';

export async function blankPreFixScheduleDestinations(
  db: DbOrTx,
  opts: { before: Date; apply: boolean },
): Promise<{ count: number; ids: string[]; applied: boolean }> {
  const due = and(eq(schedules.status, 'active'), ne(schedules.payoutDestinationEnc, ''), lt(schedules.createdAt, opts.before));
  const ids = (await db.select({ id: schedules.id }).from(schedules).where(due)).map((r) => r.id).sort();
  if (opts.apply && ids.length > 0) {
    await db
      .update(schedules)
      .set({ payoutMethod: 'bank', payoutDestinationEnc: '', payoutDestinationLast4: '' })
      .where(and(inArray(schedules.id, ids), due));
  }
  return { count: ids.length, ids, applied: opts.apply };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — source .env.local first.');
    process.exit(1);
  }
  const i = process.argv.indexOf('--before');
  const before = new Date(i >= 0 ? (process.argv[i + 1] ?? '') : '');
  if (Number.isNaN(before.getTime())) {
    console.error('--before <ISO> is required: the fix 6 deploy time (schedules created after it hold server-rehydrated destinations).');
    process.exit(1);
  }
  // A cutoff in the future would also blank POST-fix schedules, whose
  // destinations were rehydrated server-side from the sender's own records.
  if (before.getTime() > Date.now()) {
    console.error('--before must not be in the future: pass the fix 6 production deploy time.');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  const r = await blankPreFixScheduleDestinations(getDb(), { before, apply });
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${r.count} active schedule(s) created before ${before.toISOString()} ${apply ? 'blanked' : 'would be blanked'}.`);
  if (r.ids.length) console.log(r.ids.join('\n'));
}

if (process.argv[1]?.endsWith('blank-prefix-schedule-destinations.ts')) {
  main().then(() => process.exit(0)).catch((e) => { console.error('blank-prefix-schedule-destinations failed:', e); process.exit(1); });
}
