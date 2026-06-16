/**
 * Promote already-wired simulator-rail partners into polished DEMO partners.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/promote-demo-partners.ts
 *
 * WHY this exists alongside seed-demo-partners.ts: integration secrets are
 * encrypted at rest with FIELD_ENCRYPTION_KEY, which is Vercel-only (never on a
 * dev laptop, by design). So CREATING a new partner's rail cannot be done from a
 * laptop. But the e2e smoke suite has already provisioned several partners with a
 * working `simulator` rail (settlementUrl → prod /api/partner-rail, secrets
 * encrypted with the prod key). This script REUSES those: it only edits the
 * PLAINTEXT partner row (name/countries/brand) and the PLAINTEXT partner_rates —
 * neither of which needs the encryption key — so it runs from anywhere.
 *
 * Result: demo partners across SEND corridors (destination India-only today),
 * each on a real signed simulator rail, with a populated Rates board and one
 * best-rate winner on USD→INR. Idempotent (keyed by demo name).
 *
 * NOTE: API keys + new integrations need the prod pepper/key, so for the
 * partner-API curl path issue a key from the partner's API-keys tab on the live
 * site. The WhatsApp (default-tenant) + Rates + settlement demo needs no key.
 */
import { getDb } from '@/db/client';
import { sql } from 'drizzle-orm';
import { getPartnerStore } from '@/lib/partner-store';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { newTransferId } from '@/lib/id';
import { getFxRates } from '@/lib/rate';
import type { CountryCode, CurrencyCode } from '@/lib/types';

interface DemoTarget {
  name: string;
  country: CountryCode;
  currency: CurrencyCode;
  usdMarginBps: number;  // USD→INR board position
  homeMarginBps: number; // currency→INR (breadth)
  winner?: boolean;      // pushes a strictly-better USD→INR wholesale rate
}

const TARGETS: DemoTarget[] = [
  { name: 'Acme Remit',     country: 'US', currency: 'USD', usdMarginBps: 45, homeMarginBps: 45, winner: true },
  { name: 'Britannia Send', country: 'GB', currency: 'GBP', usdMarginBps: 30, homeMarginBps: 40 },
  { name: 'Gulf Money',     country: 'AE', currency: 'AED', usdMarginBps: 20, homeMarginBps: 55 },
  { name: 'Lion Pay',       country: 'SG', currency: 'SGD', usdMarginBps: 25, homeMarginBps: 35 },
];

async function main() {
  const db = getDb();
  const partnerStore = getPartnerStore();
  const rates = createPartnerRateRepo(db);

  // Simulator-rail partners (already wired), newest first. id 'default' excluded.
  const simRows = ((await db.execute(sql`
    SELECT p.id, p.name
    FROM partners p JOIN partner_integrations pi ON pi.partner_id = p.id
    WHERE pi.payment_provider_type = 'simulator' AND p.id <> 'default'
    ORDER BY p.created_at DESC
  `)) as unknown as { rows: Array<{ id: string; name: string }> }).rows;

  const claimed = new Set<string>();
  // Keep prior demo promotions stable: a partner already named as a demo target.
  const byName = new Map(simRows.map((r) => [r.name, r.id] as const));

  const usdMid = (await getFxRates('USD')).toInr;
  const winnerPushedRate = Math.round((usdMid + 2) * 100) / 100;
  const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  console.log(`\nPromoting ${TARGETS.length} simulator partners to demo partners`);
  console.log(`  simulator partners available : ${simRows.length}`);
  console.log(`  live USD→INR mid             : ${usdMid}`);
  console.log(`  winner pushed USD→INR rate   : ${winnerPushedRate} (24h TTL)\n`);

  if (simRows.length < TARGETS.length) {
    throw new Error(`Need ${TARGETS.length} simulator-rail partners, found ${simRows.length}. Create more via the wizard (Settlement = Simulator) first.`);
  }

  for (const t of TARGETS) {
    // Idempotent: reuse the partner already promoted to this demo name, else
    // claim an unclaimed simulator partner.
    let id = byName.get(t.name);
    if (!id) {
      const pick = simRows.find((r) => !claimed.has(r.id) && r.name !== t.name && !TARGETS.some((x) => x.name === r.name));
      if (!pick) throw new Error(`No unclaimed simulator partner left for ${t.name}.`);
      id = pick.id;
    }
    claimed.add(id);

    const existing = await partnerStore.getPartner(id);
    if (!existing) throw new Error(`Partner ${id} vanished.`);
    // Rename + re-corridor — PLAINTEXT partner row only; integrations (the rail
    // + its encrypted secrets) are a separate table and stay intact.
    await partnerStore.savePartner({
      ...existing,
      name: t.name,
      displayName: t.name,
      brandName: t.name,
      countries: [t.country],
      kycMode: 'ours',
      requireKycBeforeSend: false,
      updatedAt: new Date().toISOString(),
    });

    // USD→INR board position + (winner) a strictly-better fresh pushed rate.
    await rates.upsertRate({
      id: newTransferId(),
      partnerId: id,
      sourceCurrency: 'USD',
      destinationCurrency: 'INR',
      marginBps: t.usdMarginBps,
      ...(t.winner ? { effectiveRate: winnerPushedRate, expiresAt: in24h, pushedAt: new Date().toISOString() } : {}),
    });
    // Home-corridor margin for breadth (skip USD for the US partner).
    if (t.currency !== 'USD') {
      await rates.upsertRate({
        id: newTransferId(),
        partnerId: id,
        sourceCurrency: t.currency,
        destinationCurrency: 'INR',
        marginBps: t.homeMarginBps,
      });
    }
    console.log(`  ✓ ${t.name.padEnd(16)} ← ${id}  (${t.country}/${t.currency})${t.winner ? '  [USD→INR best-rate winner]' : ''}`);
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log('DEMO READY');
  console.log('──────────────────────────────────────────────────────────');
  console.log('• Rates page : /admin-dashboard/rates  → live mid + 4 partners on USD→INR + FRESH badges; Acme winning.');
  console.log('• Partners   : /admin-dashboard/partners → Acme Remit / Britannia Send / Gulf Money / Lion Pay (Active, Simulator rail).');
  console.log('• Routing    : send as the DEFAULT-tenant customer (shared WhatsApp number) so best-rate engages; Acme wins USD→INR.');
  console.log('• Settlement : the simulator rail runs the real signed instruct→callback loop on prod.');
  console.log('• Partner-API curl path: issue a key from a partner’s API-keys tab on the live site (keys need the prod pepper).');
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => { console.error('promote failed:', e); process.exit(1); });
