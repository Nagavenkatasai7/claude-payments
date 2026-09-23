/**
 * READ-ONLY sweep for the ctx-01 blast radius left by rows written before Phase
 * 1 fix 6 (Program-Fix 10). SELECTs only; decrypts in process; prints ids,
 * tenant, status, dates and last-4 of phones — never a destination, never a
 * full phone number.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/audit-masked-destinations.ts [--before <fix deploy ISO>]
 *
 * After fix 6 (this script rewrites nothing):
 *   • placeholder transfers: awaiting_payment self-heal (the pay page collects);
 *     paid / in_review ones are REFUSED by the rail instruction → ops obtains the
 *     real account or refunds — never guess one.
 *   • placeholder recipients: self-heal (rehydration skips them).
 *   • CONSUMER transfers with a partner-pulled funding method: never captured —
 *     the pay route now refuses them and the rail instruction throws; review each.
 *   • active schedules with a non-consumer funding method: every run now fails.
 *   • active schedules holding ANY destination written before --before: a model
 *     invention (e.g. "xxxx9012") is not recognisable — blank them with the
 *     SEPARATE owner-run scripts/blank-prefix-schedule-destinations.ts.
 */
import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { getDb, type DbOrTx } from '@/db/client';
import { recipients, schedules, transfers } from '@/db/schema';
import { defaultProvider, type CryptoContext } from '@/lib/field-crypto';
import { ctx, recipientRowCtx } from '@/lib/crypto-context';
import { openOptional } from '@/db/repos/mappers';
import { isMaskedDestination } from '@/lib/payout-format';

const CONSUMER_FUNDING = ['credit_card', 'debit_card', 'bank_transfer'];

export interface MaskedRowsReport {
  transfers: { id: string; partner_id: string; status: string; created_at: string }[];
  recipients: { partner_id: string; sender_last4: string; recipient_last4: string; last_used_at: string }[];
  schedules: { id: string; partner_id: string; status: string }[];
  pulledConsumerTransfers: { id: string; partner_id: string; status: string; funding_method: string; created_at: string }[];
  nonConsumerFundingSchedules: { id: string; partner_id: string; funding_method: string }[];
  preFixScheduleDestinations: { id: string; partner_id: string; created_at: string }[];
}

/** Pure over the db handle; exported so the sweep is unit-tested on PGlite. */
export async function findMaskedDestinationRows(
  db: DbOrTx,
  opts: { before?: Date } = {},
): Promise<MaskedRowsReport> {
  const provider = defaultProvider();
  // Each blob opens under the context built from ITS OWN row (Program-Fix 46A).
  const masked = (blob: string | null, c: CryptoContext) => isMaskedDestination(openOptional(blob, provider, c));

  const tRows = await db
    .select({ id: transfers.id, partnerId: transfers.partnerId, status: transfers.status, createdAt: transfers.createdAt, enc: transfers.payoutDestinationEnc })
    .from(transfers);
  const rRows = await db
    .select({ partnerId: recipients.partnerId, senderPhone: recipients.senderPhone, recipientPhone: recipients.recipientPhone, lastUsedAt: recipients.lastUsedAt, enc: recipients.payoutDestinationEnc })
    .from(recipients);
  const sRows = await db
    .select({ id: schedules.id, partnerId: schedules.partnerId, status: schedules.status, createdAt: schedules.createdAt, fundingMethod: schedules.fundingMethod, enc: schedules.payoutDestinationEnc })
    .from(schedules)
    .where(eq(schedules.status, 'active'));
  const pRows = await db
    .select({ id: transfers.id, partnerId: transfers.partnerId, status: transfers.status, fundingMethod: transfers.fundingMethod, createdAt: transfers.createdAt })
    .from(transfers)
    .where(and(eq(transfers.transferType, 'b2c'), inArray(transfers.fundingMethod, ['ach_pull', 'bank_pull'])));
  const preFix = opts.before
    ? await db
        .select({ id: schedules.id, partnerId: schedules.partnerId, createdAt: schedules.createdAt })
        .from(schedules)
        .where(and(eq(schedules.status, 'active'), ne(schedules.payoutDestinationEnc, ''), lt(schedules.createdAt, opts.before)))
    : [];

  return {
    transfers: tRows.filter((r) => masked(r.enc, ctx.transfer(r.id, 'payout_destination_enc'))).map((r) => ({ id: r.id, partner_id: r.partnerId, status: r.status, created_at: r.createdAt.toISOString() })),
    recipients: rRows.filter((r) => masked(r.enc, recipientRowCtx(r))).map((r) => ({
      partner_id: r.partnerId, sender_last4: r.senderPhone.slice(-4), recipient_last4: r.recipientPhone.slice(-4),
      last_used_at: r.lastUsedAt.toISOString(),
    })),
    schedules: sRows.filter((r) => masked(r.enc, ctx.schedule(r.id))).map((r) => ({ id: r.id, partner_id: r.partnerId, status: r.status })),
    pulledConsumerTransfers: pRows.map((r) => ({
      id: r.id, partner_id: r.partnerId, status: r.status, funding_method: r.fundingMethod, created_at: r.createdAt.toISOString(),
    })),
    nonConsumerFundingSchedules: sRows
      .filter((r) => !CONSUMER_FUNDING.includes(r.fundingMethod))
      .map((r) => ({ id: r.id, partner_id: r.partnerId, funding_method: r.fundingMethod })),
    preFixScheduleDestinations: preFix.map((r) => ({ id: r.id, partner_id: r.partnerId, created_at: r.createdAt.toISOString() })),
  };
}

function parseBefore(argv: string[]): Date | undefined {
  const i = argv.indexOf('--before');
  if (i < 0) return undefined;
  const d = new Date(argv[i + 1] ?? '');
  if (Number.isNaN(d.getTime())) throw new Error('--before needs an ISO timestamp (the fix 6 deploy time).');
  return d;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — source .env.local first.');
    process.exit(1);
  }
  const host = (() => { try { return new URL(process.env.DATABASE_URL ?? '').host; } catch { return '?'; } })();
  const before = parseBefore(process.argv);
  console.log(`\nctx-01 audit against ${host} — ${new Date().toISOString()}${before ? ` (pre-fix cutoff ${before.toISOString()})` : ''}`);
  const report = await findMaskedDestinationRows(getDb(), { before });
  const section = (title: string, rows: Record<string, unknown>[]) => {
    console.log(`\n${title}`);
    if (rows.length === 0) console.log('  none');
    else console.table(rows);
  };
  section('TRANSFERS whose payout destination is a display placeholder', report.transfers);
  section('RECIPIENTS holding a placeholder — self-heal', report.recipients);
  section('ACTIVE SCHEDULES carrying a placeholder', report.schedules);
  section('CONSUMER TRANSFERS with a partner-pulled funding method — review each', report.pulledConsumerTransfers);
  section('ACTIVE SCHEDULES with a non-consumer funding method — cancel or re-create', report.nonConsumerFundingSchedules);
  section('ACTIVE SCHEDULES holding ANY destination written before the cutoff — blank via the separate script', report.preFixScheduleDestinations);
  console.log(
    `\nSUMMARY: transfers=${report.transfers.length} recipients=${report.recipients.length} schedules=${report.schedules.length} ` +
    `pulledConsumer=${report.pulledConsumerTransfers.length} nonConsumerFundingSchedules=${report.nonConsumerFundingSchedules.length} ` +
    `preFixScheduleDestinations=${before ? report.preFixScheduleDestinations.length : 'n/a (pass --before)'}\n`,
  );
}

if (process.argv[1]?.endsWith('audit-masked-destinations.ts')) {
  main().then(() => process.exit(0)).catch((e) => { console.error('audit-masked-destinations failed:', e); process.exit(1); });
}
