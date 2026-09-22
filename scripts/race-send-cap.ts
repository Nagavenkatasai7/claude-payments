/**
 * Program fix 16 (Task 10, acceptance test 10) — REAL concurrency check for the
 * per-sender mint lock, run by the OWNER against a THROWAWAY Neon branch
 * (never prod, never CI). PGlite runs one transaction at a time, so this is the
 * only place two connections genuinely race for the same (partner, phone).
 *
 *   1. Neon MCP `create_branch` (or the console) from the prod branch, then
 *      apply the migrations to it:
 *        set -a; source .env.local; set +a
 *        DATABASE_URL=<branch pooled url> DATABASE_URL_UNPOOLED=<branch direct url> npx drizzle-kit migrate
 *   2. Run (the POSITIVE gate: RACE_ALLOW_HOST must equal the branch host, so a
 *      sourced prod .env.local can never be the target by accident; optionally
 *      PROD_DB_HOST=<prod hostname> as a second, negative gate; the host must
 *      also look like a Neon endpoint, ep-….aws.neon.tech):
 *        DATABASE_URL=<branch pooled url> RACE_ALLOW_HOST=<that url's hostname> node_modules/.bin/tsx scripts/race-send-cap.ts
 *   3. Quote the output in the PR, then delete the branch.
 *
 * What it checks (all three MUST print PASS):
 *   A. two $300 mints for one T0 sender at once ⇒ exactly one row + one SendCapError;
 *   B. $1,500 seeded yesterday, then 2×$800 at once ⇒ both rows, exactly one is
 *      flagged edd_required (the $3,100 month), neither refused;
 *   C. two mints with the SAME input.id at once ⇒ one row, both callers get it,
 *      no primary-key error.
 * Each check uses a fresh throwaway phone and its own two Pools (two real
 * connections). It writes only rows for those phones and deletes them after.
 * No PII: the recipient is a placeholder and the log prints ids and statuses only.
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from '@/db/schema';
import { easternDayStart, easternMonthStart } from '@/lib/dates';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createTransfer, type CreateTransferInput } from '@/lib/transfer-create';
import { SendCapError } from '@/lib/send-limits';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import type { Db } from '@/db/client';
import type { RedisLike } from '@/lib/store';
import type { Transfer } from '@/lib/types';

neonConfig.webSocketConstructor = ws;

const url = process.env.DATABASE_URL ?? '';
if (!url) {
  console.error('DATABASE_URL not set (point it at a THROWAWAY Neon branch, never prod).');
  process.exit(1);
}
// Positive gate (security review): the script seeds a fake 'paid' row and
// DELETEs rows for its synthetic phones, so it must never run against prod.
// It runs ONLY when RACE_ALLOW_HOST names the exact host DATABASE_URL points at.
const targetHost = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
if (!targetHost || !process.env.RACE_ALLOW_HOST || process.env.RACE_ALLOW_HOST !== targetHost) {
  console.error(`Refusing: set RACE_ALLOW_HOST to the throwaway branch host (DATABASE_URL points at "${targetHost || '?'}").`);
  process.exit(1);
}
// Negative gates (review): never the prod host, and only a Neon endpoint host
// (ep-<slug>[-pooler].<region>.aws.neon.tech) — a pasted non-Neon URL is refused.
if (process.env.PROD_DB_HOST && targetHost === process.env.PROD_DB_HOST) {
  console.error('Refusing: DATABASE_URL points at PROD_DB_HOST.');
  process.exit(1);
}
if (!/^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)+\.aws\.neon\.tech$/.test(targetHost)) {
  console.error(`Refusing: "${targetHost}" is not a Neon branch endpoint host.`);
  process.exit(1);
}

// No Redis is touched by the mint path any more (fix 16); an inert stub keeps createStore happy.
const noRedis: RedisLike = {
  get: async () => null, set: async () => 'OK', del: async () => 1, incr: async () => 1,
  sadd: async () => 1, srem: async () => 1, smembers: async () => [], hset: async () => 1,
  hget: async () => null, hgetall: async () => null, hdel: async () => 1, getdel: async () => null,
  exists: async () => 0, expire: async () => 1,
};

function conn(): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: url });
  return { db: drizzle(pool, { schema }) as unknown as Db, pool };
}

const RECIPIENT = { recipientName: 'Race Check', recipientPhone: '919000000001', payoutMethod: 'upi' as const, payoutDestination: 'race@upi' };

function input(phone: string, amountSource: number, id?: string): CreateTransferInput {
  return {
    ...(id ? { id } : {}),
    phone, amountSource, sourceCurrency: 'USD', partnerId: 'default',
    fundingMethod: 'bank_transfer', senderKycStatus: 'verified', ...RECIPIENT,
    // A complete quote override: no FX fetch, deterministic figures.
    quote: {
      amountUsd: amountSource, feeUsd: 0, totalChargeUsd: amountSource, fxRate: 85,
      amountInr: amountSource * 85, amountSource, feeSource: 0, totalChargeSource: amountSource,
    },
  };
}

async function mintVia(db: Db, i: CreateTransferInput): Promise<{ ok: true; t: Transfer } | { ok: false; err: unknown }> {
  const store = createStore(noRedis, db);
  try {
    return { ok: true, t: await createTransfer(store, createPartnerStore(db), createMonthlyVolumeStore(store), i) };
  } catch (err) {
    return { ok: false, err };
  }
}

async function rowsFor(db: Db, phone: string) {
  const r = await db.execute(sql`SELECT id, status, compliance_status, compliance_reasons FROM transfers WHERE partner_id = 'default' AND phone = ${phone} ORDER BY created_at`);
  return (r as unknown as { rows: Array<{ id: string; status: string; compliance_status: string; compliance_reasons: string[] }> }).rows;
}

async function cleanup(db: Db, phone: string) {
  await db.execute(sql`DELETE FROM recipients WHERE partner_id = 'default' AND sender_phone = ${phone}`);
  await db.execute(sql`DELETE FROM transfers WHERE partner_id = 'default' AND phone = ${phone}`);
}

async function main() {
  const a = conn();
  const b = conn();
  const stamp = Date.now().toString().slice(-7);
  let failures = 0;
  const report = (name: string, pass: boolean, detail: string) => {
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  };

  // A. two $300 T0 mints at once ⇒ one row, one SendCapError
  {
    const phone = `1555${stamp}1`;
    await cleanup(a.db, phone);
    const [r1, r2] = await Promise.all([mintVia(a.db, input(phone, 300)), mintVia(b.db, input(phone, 300))]);
    const rows = await rowsFor(a.db, phone);
    const caps = [r1, r2].filter((r) => !r.ok && r.err instanceof SendCapError).length;
    const oks = [r1, r2].filter((r) => r.ok).length;
    const other = [r1, r2].filter((r) => !r.ok && !(r.err instanceof SendCapError)).map((r) => String((r as { err: unknown }).err));
    report('A: two $300 T0 mints at once → one row, one SendCapError',
      rows.length === 1 && oks === 1 && caps === 1,
      `rows=${rows.length} ok=${oks} cap=${caps} other=${JSON.stringify(other)}`);
    await cleanup(a.db, phone);
  }

  // B. $1,500 yesterday, then 2×$800 at once ⇒ both rows, exactly one edd_required
  {
    const phone = `1555${stamp}2`;
    await cleanup(a.db, phone);
    // A T1 sender: a customers row 10 days old, verified.
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    await a.db.execute(sql`INSERT INTO customers (phone, partner_id, first_seen_at, sender_country, kyc_status)
      VALUES (${phone}, 'default', ${tenDaysAgo}, 'US', 'verified')
      ON CONFLICT (partner_id, phone) DO UPDATE SET first_seen_at = ${tenDaysAgo}, kyc_status = 'verified'`);
    // "Yesterday" must be in THIS ET month (the EDD window). On the 1st of the
    // ET month there is no such day: a same-day seed would trip the daily cap
    // first, so B is SKIPPED (not failed) — rerun tomorrow.
    const now = new Date();
    const yesterday = new Date(easternDayStart(now).getTime() - 12 * 3_600_000); // noon ET, previous day
    if (yesterday.getTime() < easternMonthStart(now).getTime()) {
      console.log('SKIP  B: today is the 1st of the ET month — no prior day in the EDD window; rerun tomorrow.');
      await cleanup(a.db, phone);
      await a.db.execute(sql`DELETE FROM customers WHERE partner_id = 'default' AND phone = ${phone}`);
    } else {
    await createTransferRepo(a.db).saveTransfer({
      id: `race_seed_${stamp}`, phone, amountUsd: 1500, feeUsd: 0, totalChargeUsd: 1500, fxRate: 85, amountInr: 127_500,
      ...RECIPIENT, fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'paid',
      createdAt: yesterday.toISOString(), sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
      partnerId: 'default', amountSource: 1500, feeSource: 0, totalChargeSource: 1500,
    });
    const [r1, r2] = await Promise.all([mintVia(a.db, input(phone, 800)), mintVia(b.db, input(phone, 800))]);
    const rows = await rowsFor(a.db, phone);
    const minted = rows.filter((r) => r.id !== `race_seed_${stamp}`);
    const edd = minted.filter((r) => r.compliance_reasons.includes('edd_required')).length;
    report('B: $1,500 yesterday + 2×$800 at once → both minted, exactly one edd_required, none refused',
      r1.ok && r2.ok && minted.length === 2 && edd === 1,
      `ok=${[r1, r2].filter((r) => r.ok).length} minted=${minted.length} edd_required=${edd} statuses=${JSON.stringify(minted.map((r) => r.compliance_status))}`);
    await cleanup(a.db, phone);
    await a.db.execute(sql`DELETE FROM customers WHERE partner_id = 'default' AND phone = ${phone}`);
    }
  }

  // C. two mints with the SAME input.id at once ⇒ one row, both callers get it, no PK error
  {
    const phone = `1555${stamp}3`;
    await cleanup(a.db, phone);
    const id = `race_same_${stamp}`;
    const [r1, r2] = await Promise.all([mintVia(a.db, input(phone, 100, id)), mintVia(b.db, input(phone, 100, id))]);
    const rows = await rowsFor(a.db, phone);
    const ids = [r1, r2].map((r) => (r.ok ? r.t.id : `ERR:${String((r as { err: unknown }).err)}`));
    report('C: same input.id at once → one row, both return it, no primary-key error',
      rows.length === 1 && ids.every((x) => x === id),
      `rows=${rows.length} returned=${JSON.stringify(ids)}`);
    await cleanup(a.db, phone);
  }

  await a.pool.end();
  await b.pool.end();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('race-send-cap failed:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
