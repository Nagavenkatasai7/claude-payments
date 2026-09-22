/**
 * READ-ONLY audit of every partner's settlement URL against the fix 22 rule
 * (src/lib/settlement-url.ts) PLUS a live DNS lookup of the host with the same
 * address classifier the worker's safeFetch applies at connect time.
 *
 * Owner runs it BEFORE merging fix 22 and expects OK for every http/simulator
 * partner (task-12.md §8). Prints partner id, providerType, HOST ONLY and the
 * verdict — never the full URL, never a secret. DECRYPT_FAILED is a stop.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/audit-settlement-urls.ts
 *
 * Exit 1 if any http/simulator partner is not OK.
 *
 * Reads only through createPartnerRepo(db).listPartners() and
 * createIntegrationsRepo(db).getIntegrations(id) — never getPartnerStore() or
 * ensureDefaultPartner (which can write) — inside ONE read-only transaction
 * (drizzle PgTransactionConfig.accessMode, node_modules/drizzle-orm/pg-core/session.d.ts:33),
 * so an accidental write would fail. Checks with production: true and the
 * explicit origin https://smartremit.ai, never env.appBaseUrl (.env.local may
 * say localhost).
 */
import dns from 'node:dns';
import { getDb } from '@/db/client';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { checkSettlementUrl, isPublicAddress } from '@/lib/settlement-url';

const PROD_ORIGIN = 'https://smartremit.ai';
const WEBHOOK_DRIVEN = new Set(['http', 'simulator']);

type Verdict = { partnerId: string; providerType: string; host: string; verdict: string };

async function verdictFor(url: string | undefined): Promise<{ host: string; verdict: string }> {
  if (!url) return { host: '-', verdict: 'MISSING' };
  const check = checkSettlementUrl(url, { appOrigin: PROD_ORIGIN, production: true });
  if (!check.ok) {
    let host = '?';
    try { host = new URL(url).hostname; } catch { /* unparseable — keep '?' */ }
    return { host, verdict: check.reason };
  }
  const host = check.url.hostname;
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    return { host, verdict: 'dns_failed' };
  }
  if (addrs.length === 0) return { host, verdict: 'dns_failed' };
  if (!addrs.every((a) => isPublicAddress(a.address))) return { host, verdict: 'private_address' };
  return { host, verdict: 'OK' };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — source .env.local first.');
    process.exit(1);
  }
  const db = getDb();
  const dbHost = (() => { try { return new URL(process.env.DATABASE_URL ?? '').host; } catch { return '?'; } })();
  console.log(`\nSettlement URL audit against ${dbHost} — ${new Date().toISOString()}`);
  console.log(`rule: src/lib/settlement-url.ts (production: true, app origin ${PROD_ORIGIN}) + live DNS lookup + isPublicAddress`);

  const rows: Verdict[] = await db.transaction(
    async (tx) => {
      const partners = await createPartnerRepo(tx).listPartners();
      const integrations = createIntegrationsRepo(tx);
      const out: Verdict[] = [];
      for (const p of partners) {
        try {
          const cfg = await integrations.getIntegrations(p.id);
          const providerType = cfg.payment.providerType ?? '-';
          const url = cfg.payment.credentials?.settlementUrl;
          if (!WEBHOOK_DRIVEN.has(providerType) && !url) {
            out.push({ partnerId: p.id, providerType, host: '-', verdict: 'n/a (no rail)' });
            continue;
          }
          const v = await verdictFor(url);
          out.push({ partnerId: p.id, providerType, ...v });
        } catch {
          // openOptional throws on a bad ciphertext (mappers.ts): never OK.
          out.push({ partnerId: p.id, providerType: '?', host: '-', verdict: 'DECRYPT_FAILED' });
        }
      }
      return out;
    },
    { accessMode: 'read only' },
  );

  console.table(rows);
  const failing = rows.filter((r) => WEBHOOK_DRIVEN.has(r.providerType) || r.verdict === 'DECRYPT_FAILED')
    .filter((r) => r.verdict !== 'OK');
  if (failing.length === 0) {
    console.log(`\nSUMMARY: OK — every http/simulator partner passes (${rows.length} partner(s) checked)\n`);
    return 0;
  }
  console.log(`\nSUMMARY: ${failing.length} partner(s) NOT OK — fix the endpoint in Admin → Partners → Payment before merging; DECRYPT_FAILED is a stop\n`);
  return 1;
}

main().then((code) => process.exit(code)).catch((e) => { console.error('audit-settlement-urls failed:', e instanceof Error ? e.message : e); process.exit(1); });
