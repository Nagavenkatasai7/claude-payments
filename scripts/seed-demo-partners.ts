/**
 * Seed demo partners for the end-to-end PARTNER demo.
 *
 *   set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/seed-demo-partners.ts
 *
 * Optional env:
 *   SEED_BASE_URL   base URL whose /api/partner-rail the simulator settlement
 *                   instruction is POSTed to. MUST match the deployment that
 *                   runs the worker (default https://smartremit.ai). A localhost
 *                   value would be unreachable from the prod worker.
 *
 * Idempotent: partners use stable ids (demo-<slug>); an existing partner is left
 * as-is (its API key cannot be re-shown — re-issue from the API-keys tab), and
 * its rates/margins are re-applied. Reuses the SAME logic the admin wizard uses
 * (wizardCreatePartnerAction): partner row + integrations (simulator auto-
 * provisions settlementUrl + both HMAC secrets) + a one-time API key, plus
 * best-rate rows via the partner-rate repo (same as the Pricing tab / PUT /rates).
 *
 * Creates partners across SEND corridors (destination is India-only today):
 *   Acme Remit (US/USD)   — best-rate WINNER: pushes a strictly-better USD→INR rate
 *   Britannia Send (UK/GBP)
 *   Gulf Money (AE/AED)
 *   Lion Pay (SG/SGD)
 * All four also carry a differentiated USD→INR margin so the Rates page shows a
 * full competitive board on the USD→INR corridor.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@/db/client';
import { getPartnerStore } from '@/lib/partner-store';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { getPartnerApiKeyStore } from '@/lib/partner-api-key';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { newTransferId } from '@/lib/id';
import { getFxRates } from '@/lib/rate';
import { env } from '@/lib/env';
import type { Partner, CurrencyCode, CountryCode } from '@/lib/types';

const BASE = (process.env.SEED_BASE_URL ?? env.appBaseUrl ?? 'https://smartremit.ai').replace(/\/$/, '');

/**
 * Ensure FIELD_ENCRYPTION_KEY is in process.env and valid (hex64 OR base64→32),
 * so integration secrets are encrypted at rest with the SAME key prod uses (else
 * the worker could not decrypt the signing secret). Shell `source` / Node
 * `--env-file` both drop a quoted/multiline value, so when it is absent we parse
 * .env.local directly — stripping quotes and any internal whitespace/newlines.
 * The secret is NEVER printed.
 */
function isValid32(raw: string): boolean {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return true;
  try { return Buffer.from(raw, 'base64').length === 32; } catch { return false; }
}
function ensureCryptoKey(): void {
  const current = process.env.FIELD_ENCRYPTION_KEY ?? '';
  if (isValid32(current)) return;
  let text = '';
  try { text = readFileSync(join(process.cwd(), '.env.local'), 'utf8'); } catch { /* no file */ }
  // Match KEY= then either a double-quoted (possibly multiline) or bare value.
  const m = text.match(/FIELD_ENCRYPTION_KEY\s*=\s*("([\s\S]*?)"|'([\s\S]*?)'|([^\r\n]*))/);
  const captured = (m?.[2] ?? m?.[3] ?? m?.[4] ?? '').replace(/\s+/g, '');
  if (isValid32(captured)) { process.env.FIELD_ENCRYPTION_KEY = captured; return; }
  throw new Error(
    'FIELD_ENCRYPTION_KEY could not be loaded from the environment or .env.local. ' +
    'Set it (hex64 or base64-32) before seeding so integration secrets match prod.',
  );
}

interface DemoPartner {
  slug: string;
  name: string;
  country: CountryCode;
  currency: CurrencyCode;
  /** USD→INR margin (bps) so it appears on the headline corridor's board. */
  usdMarginBps: number;
  /** Home-corridor (currency→INR) margin (bps) for multi-corridor breadth. */
  homeMarginBps: number;
  /** The single best-rate winner pushes a literal strictly-better USD→INR rate. */
  winner?: boolean;
}

const DEMO: DemoPartner[] = [
  { slug: 'acme',      name: 'Acme Remit (demo)',      country: 'US', currency: 'USD', usdMarginBps: 45, homeMarginBps: 45, winner: true },
  { slug: 'britannia', name: 'Britannia Send (demo)',  country: 'GB', currency: 'GBP', usdMarginBps: 30, homeMarginBps: 40 },
  { slug: 'gulf',      name: 'Gulf Money (demo)',      country: 'AE', currency: 'AED', usdMarginBps: 20, homeMarginBps: 55 },
  { slug: 'lion',      name: 'Lion Pay (demo)',        country: 'SG', currency: 'SGD', usdMarginBps: 25, homeMarginBps: 35 },
];

async function main() {
  ensureCryptoKey();
  const partnerStore = getPartnerStore();
  const integrationsStore = getPartnerIntegrationsStore();
  const apiKeyStore = getPartnerApiKeyStore();
  const rates = createPartnerRateRepo(getDb());

  // Live mid for the winner's strictly-better pushed rate (real Frankfurter when
  // run against a deployment with egress; falls back to 85 offline).
  const usdMid = (await getFxRates('USD')).toInr;
  const winnerPushedRate = Math.round((usdMid + 2) * 100) / 100; // strictly > mid
  const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  console.log(`\nSeeding ${DEMO.length} demo partners`);
  console.log(`  settlement rail base : ${BASE}/api/partner-rail`);
  console.log(`  live USD→INR mid     : ${usdMid}`);
  console.log(`  winner pushed rate   : ${winnerPushedRate} (USD→INR, 24h TTL)\n`);

  const issued: Array<{ name: string; id: string; apiKey: string | null }> = [];

  for (const d of DEMO) {
    const id = `demo-${d.slug}`;
    const existing = await partnerStore.getPartner(id);
    let apiKey: string | null = null;

    if (!existing) {
      const now = new Date().toISOString();
      const partner: Partner = {
        id,
        name: d.name,
        countries: [d.country],
        status: 'active',
        displayName: d.name.replace(' (demo)', ''),
        brandName: d.name.replace(' (demo)', ''),
        kycMode: 'ours',
        requireKycBeforeSend: false, // gate OFF for a frictionless demo
        createdAt: now,
        updatedAt: now,
      };
      await partnerStore.savePartner(partner);
      console.log(`  ✓ created ${id}  (${d.country}/${d.currency})`);
    } else {
      console.log(`  • exists  ${id}  (ensuring rail + rates)`);
    }

    // Ensure the simulator rail (idempotent): auto-provision the endpoint + both
    // HMAC secrets if not already configured — the exact zero-setup wiring the
    // wizard performs for providerType 'simulator'.
    const integ = await integrationsStore.getIntegrations(id);
    if (integ.payment?.providerType !== 'simulator') {
      await integrationsStore.saveIntegrations(id, {
        kyc: {},
        whatsapp: {},
        payment: {
          providerType: 'simulator',
          credentials: {
            settlementUrl: `${BASE}/api/partner-rail`,
            signingSecret: randomBytes(32).toString('hex'),
          },
          webhookSecret: randomBytes(32).toString('hex'),
        },
      });
    }

    // Ensure an API key (idempotent): issue only if the partner has none.
    const keys = await apiKeyStore.list(id);
    if (keys.length === 0) {
      apiKey = (await apiKeyStore.issue(id)).plaintext;
    }

    // USD→INR margin (headline corridor board). The winner also pushes a literal
    // strictly-better wholesale rate (fresh, 24h) so it visibly wins routing.
    await rates.upsertRate({
      id: newTransferId(),
      partnerId: id,
      sourceCurrency: 'USD',
      destinationCurrency: 'INR',
      marginBps: d.usdMarginBps,
      ...(d.winner ? { effectiveRate: winnerPushedRate, expiresAt: in24h, pushedAt: new Date().toISOString() } : {}),
    });

    // Home-corridor margin (breadth on the Rates page) — skip USD for the US partner.
    if (d.currency !== 'USD') {
      await rates.upsertRate({
        id: newTransferId(),
        partnerId: id,
        sourceCurrency: d.currency,
        destinationCurrency: 'INR',
        marginBps: d.homeMarginBps,
      });
    }

    issued.push({ name: d.name, id, apiKey });
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log('DEMO CHEAT-SHEET');
  console.log('──────────────────────────────────────────────────────────');
  console.log('Rates page : /admin-dashboard/rates  (now shows live mid + each partner offering + FRESH badges)');
  console.log('Partners   : /admin-dashboard/partners');
  console.log('Best-rate winner on USD→INR: Acme Remit (pushed rate above).');
  console.log('\nAPI keys (shown ONCE — store securely):');
  for (const r of issued) {
    console.log(`  ${r.name}: ${r.apiKey ?? '(existing — re-issue from the API-keys tab)'}`);
  }
  console.log('\nProbe live FX + a partner key (read-only, no side effects):');
  const k = issued.find((r) => r.apiKey)?.apiKey ?? '<partner key>';
  console.log(`  curl -s -X POST ${BASE}/api/partner/v1/quote \\`);
  console.log(`    -H "Authorization: Bearer ${k}" -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"amount_source":1000,"source_currency":"USD"}' | jq .`);
  console.log('  → fx_rate should be a decimal (e.g. 85.34), NOT exactly 85.00.\n');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('seed failed:', e);
    process.exit(1);
  });
