/**
 * READ-ONLY status of best-rate routing: for every non-default partner it prints
 * status / rail / rate rows, then computes — per corridor, against the LIVE mid —
 * whether routing would fire and which partner wins. No writes; no secret is ever
 * printed. Use it to confirm the routing demo is live after a rate push.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/routing-status.ts
 *
 * Note: routability is inferred from the plaintext provider_type + presence of a
 * rail credential blob (the encrypted settlementUrl is not decrypted here). A
 * partner provisioned via the wizard/seed always has a valid settlementUrl.
 */
import { getDb } from '@/db/client';
import { sql } from 'drizzle-orm';
import { getFxRates } from '@/lib/rate';

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set — source .env.local first.'); process.exit(1); }
  const db = getDb();

  const partners = ((await db.execute(sql`
    SELECT p.id, p.name, p.status, p.countries,
           pi.payment_provider_type AS provider_type,
           (pi.payment_credentials_enc IS NOT NULL) AS has_rail_creds
    FROM partners p
    LEFT JOIN partner_integrations pi ON pi.partner_id = p.id
    WHERE p.id <> 'default'
    ORDER BY p.created_at DESC
  `)) as unknown as { rows: Array<Record<string, unknown>> }).rows;

  const rates = ((await db.execute(sql`
    SELECT partner_id, source_currency, destination_currency,
           effective_rate, expires_at, margin_bps, updated_at
    FROM partner_rates
    ORDER BY source_currency, destination_currency, partner_id
  `)) as unknown as { rows: Array<Record<string, unknown>> }).rows;

  const byId = new Map<string, Record<string, unknown>>();
  console.log(`\nNon-default partners: ${partners.length}\n`);
  console.log('PARTNERS');
  console.log('─'.repeat(94));
  for (const p of partners) {
    byId.set(String(p.id), p);
    const routableRail = (p.provider_type === 'simulator' || p.provider_type === 'http') && p.has_rail_creds === true;
    console.log(
      `  ${String(p.id).padEnd(12)} ${String(p.name ?? '').padEnd(22)} status=${String(p.status).padEnd(9)} ` +
      `rail=${String(p.provider_type ?? '(none)').padEnd(10)} routableRail=${routableRail ? 'YES' : 'no '}  ` +
      `countries=${JSON.stringify(p.countries)}`,
    );
  }

  const srcCurrencies = [...new Set(rates.map((r) => String(r.source_currency)))];
  const mids = new Map<string, number>();
  for (const c of srcCurrencies) {
    try { mids.set(c, (await getFxRates(c as never)).toInr); } catch { /* leave unset */ }
  }

  const now = Date.now();
  const offeredRate = (r: Record<string, unknown>): { offered: number | null; fresh: boolean } => {
    const mid = mids.get(String(r.source_currency));
    const eff = r.effective_rate != null ? Number(r.effective_rate) : null;
    const expMs = r.expires_at ? Date.parse(String(r.expires_at)) : null;
    const fresh = eff != null && eff > 0 && expMs != null && expMs > now;
    const margin = r.margin_bps != null ? Number(r.margin_bps) : null;
    if (fresh) return { offered: eff, fresh: true };
    if (margin != null && mid != null) return { offered: mid * (1 + margin / 10000), fresh: false };
    return { offered: null, fresh: false };
  };

  console.log('\nPER-CORRIDOR ROUTING VERDICT');
  console.log('─'.repeat(94));
  const corridors = [...new Set(rates.map((r) => `${r.source_currency}→${r.destination_currency}`))].sort();
  for (const corr of corridors) {
    const [srcC] = corr.split('→');
    const mid = mids.get(srcC);
    const contenders = rates
      .filter((r) => `${r.source_currency}→${r.destination_currency}` === corr)
      .map((r) => {
        const pid = String(r.partner_id);
        const p = byId.get(pid);
        const { offered } = offeredRate(r);
        const active = p?.status === 'active';
        const routableRail = !!p && (p.provider_type === 'simulator' || p.provider_type === 'http') && p.has_rail_creds === true;
        const eligible = !!active && routableRail && offered != null && mid != null && offered > mid && pid !== 'default';
        return { name: String(p?.name ?? '(missing partner)'), offered, eligible };
      })
      .filter((c) => c.eligible)
      .sort((a, b) => (b.offered ?? 0) - (a.offered ?? 0));
    if (contenders.length === 0) {
      console.log(`  ${corr.padEnd(10)} mid=${mid ?? '?'}  → NO eligible contender — quote stays at platform mid`);
    } else {
      const w = contenders[0];
      console.log(`  ${corr.padEnd(10)} mid=${String(mid ?? '?').padEnd(9)} → ROUTES to ${w.name.padEnd(16)} @ ${w.offered?.toFixed(2)}  [${contenders.length} competing]`);
    }
  }
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => { console.error('status failed:', e); process.exit(1); });
