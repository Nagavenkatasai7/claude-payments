/**
 * Refresh the DEMO partners' forex rates so the Rates board shows a FRESH,
 * differentiated competitive set (and no EXPIRED badges) for the demo.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/refresh-demo-rates.ts
 *
 * WHY: each demo partner models a money transmitter sourcing FX from its own
 * provider ("a different forex portal"), so each should show a DISTINCT live
 * rate. Today only Acme Remit carries a pushed rate and its 24h TTL has lapsed
 * — the board renders it EXPIRED. This re-pushes a fresh, strictly-above-mid
 * rate for EVERY demo partner on USD→INR (its headline corridor) plus each
 * non-USD partner's home corridor, with a long TTL so nothing expires mid-demo.
 *
 * Only PLAINTEXT partner_rates are touched (no encryption key, no Redis) — the
 * exact same push the partner API / Pricing tab performs — so it runs from a
 * laptop. Idempotent: upsert merges effectiveRate/expiresAt/pushedAt and leaves
 * each partner's margin_bps intact (merge semantics in partner-rate-repo).
 *
 * Ranking (best for the customer = most INR per source unit) makes Acme the
 * USD→INR best-rate winner so the routing demo still engages Acme.
 */
import { getDb } from '@/db/client';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { newTransferId } from '@/lib/id';
import { getFxRates } from '@/lib/rate';
import type { CurrencyCode } from '@/lib/types';

interface RateTarget {
  id: string;            // existing prod partner id
  name: string;          // for logging / sanity check
  home: CurrencyCode;    // the partner's home send currency
  /** Percentage above the live mid for this partner (its competitive edge). A
   *  bigger number = more INR per source unit = better for the customer. */
  edgePct: number;
}

// Ordered best→worst on edge so Acme wins USD→INR. Ids are the live prod demo
// partners (the smoke partners were removed; these are the real forex rows).
const TARGETS: RateTarget[] = [
  { id: 'nt1xjr18', name: 'Acme Remit',     home: 'USD', edgePct: 2.2 },
  { id: 'u7z3tz4y', name: 'Britannia Send', home: 'GBP', edgePct: 1.7 },
  { id: 'r31qf4e8', name: 'Gulf Money',     home: 'AED', edgePct: 1.2 },
  { id: 'jztp1b50', name: 'Lion Pay',       home: 'SGD', edgePct: 0.7 },
];

const TTL_DAYS = 45;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main() {
  const db = getDb();
  const rates = createPartnerRateRepo(db);
  const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const pushedAt = new Date().toISOString();

  // One live mid per distinct currency involved (USD always; each non-USD home).
  const currencies = [...new Set<CurrencyCode>(['USD', ...TARGETS.map((t) => t.home)])];
  const mids = new Map<CurrencyCode, number>();
  for (const c of currencies) mids.set(c, (await getFxRates(c)).toInr);

  console.log(`\nRefreshing demo forex rates (TTL ${TTL_DAYS}d, expires ${expiresAt})`);
  console.log('  live mids →', [...mids].map(([c, m]) => `${c}:${m}`).join('  '));
  console.log('');

  for (const t of TARGETS) {
    // USD→INR: the headline competitive board every demo partner sits on.
    const usdMid = mids.get('USD')!;
    const usdRate = round2(usdMid * (1 + t.edgePct / 100));
    await rates.upsertRate({
      id: newTransferId(),
      partnerId: t.id,
      sourceCurrency: 'USD',
      destinationCurrency: 'INR',
      effectiveRate: usdRate,
      expiresAt,
      pushedAt,
    });
    let line = `  ✓ ${t.name.padEnd(16)} USD→INR ${usdRate} (mid ${usdMid}, +${t.edgePct}%)`;

    // Home corridor (non-USD partners) — a fresh rate so its row is FRESH too.
    if (t.home !== 'USD') {
      const homeMid = mids.get(t.home)!;
      const homeRate = round2(homeMid * (1 + t.edgePct / 100));
      await rates.upsertRate({
        id: newTransferId(),
        partnerId: t.id,
        sourceCurrency: t.home,
        destinationCurrency: 'INR',
        effectiveRate: homeRate,
        expiresAt,
        pushedAt,
      });
      line += `  |  ${t.home}→INR ${homeRate} (mid ${homeMid})`;
    }
    console.log(line);
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log('DEMO RATES REFRESHED');
  console.log('──────────────────────────────────────────────────────────');
  console.log(`• /admin-dashboard/rates → every demo partner FRESH; Acme wins USD→INR.`);
  console.log(`• Rates stay fresh until ${expiresAt}.`);
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => { console.error('refresh failed:', e); process.exit(1); });
