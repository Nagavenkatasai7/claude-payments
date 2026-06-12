import { describe, it, expect } from 'vitest';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerRateRepo } from '@/db/repos/partner-rate-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { pushPartnerRate, listPartnerRates, type PartnerApiDeps } from '@/lib/partner-api-service';
import type { Partner } from '@/lib/types';

// partner-api-rates — the partner-facing rates API (B1). RELATIVE dates only:
// freshness windows are computed against the injected deps.now.
const NOW = new Date().toISOString();
const atSeconds = (s: number) => new Date(Date.parse(NOW) + s * 1000).toISOString();

async function harness() {
  const redis = fakeRedis();
  const db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'globex');
  let n = 0;
  const deps: PartnerApiDeps = {
    store: createStore(redis, db),
    partnerStore: createPartnerStore(db),
    monthlyVolumeStore: createMonthlyVolumeStore(redis),
    integrationsStore: createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))),
    db,
    now: () => NOW,
    genId: () => `r${n++}`,
  };
  return { deps, repo: createPartnerRateRepo(db) };
}

const partner = (id: string): Partner => ({
  id, name: id, countries: ['US'], status: 'active', createdAt: NOW, updatedAt: NOW,
});
const ACME = partner('acme');

const pushBody = (over: Record<string, unknown> = {}) => ({
  source_currency: 'USD', destination_currency: 'INR', effective_rate: 86.4, ...over,
});

describe('pushPartnerRate (PUT /rates)', () => {
  it('happy path: persists the rate and returns the saved record', async () => {
    const { deps, repo } = await harness();
    const r = await pushPartnerRate(deps, ACME, 'pk_1', pushBody({ ttl_seconds: 1800 }));
    expect(r).toMatchObject({ ok: true, status: 200 });
    if (r.ok) {
      expect(r.data).toEqual({
        source_currency: 'USD',
        destination_currency: 'INR',
        effective_rate: 86.4,
        expires_at: atSeconds(1800),
        pushed_at: NOW,
      });
    }
    const stored = await repo.getRate('acme', 'USD', 'INR');
    expect(stored).toMatchObject({ effectiveRate: 86.4, expiresAt: atSeconds(1800), pushedAt: NOW });
    // The push is audited against the API key.
    const audit = await createAuditRepo(deps.db).listByPartner('acme');
    expect(audit.some((e) => e.action === 'rates.push' && e.actor === 'pk_1')).toBe(true);
  });

  it('ttl defaults to 3600 and clamps to [60, 86400]', async () => {
    const { deps, repo } = await harness();
    await pushPartnerRate(deps, ACME, 'pk_1', pushBody());
    expect((await repo.getRate('acme', 'USD', 'INR'))?.expiresAt).toBe(atSeconds(3600));

    await pushPartnerRate(deps, ACME, 'pk_1', pushBody({ ttl_seconds: 5 }));
    expect((await repo.getRate('acme', 'USD', 'INR'))?.expiresAt).toBe(atSeconds(60));

    await pushPartnerRate(deps, ACME, 'pk_1', pushBody({ ttl_seconds: 1_000_000 }));
    expect((await repo.getRate('acme', 'USD', 'INR'))?.expiresAt).toBe(atSeconds(86_400));
  });

  it('rejects an unsupported currency, a same-currency corridor, and a bad rate with 400', async () => {
    const { deps, repo } = await harness();
    const bad = [
      pushBody({ source_currency: 'XYZ' }),
      pushBody({ destination_currency: 'BTC' }),
      pushBody({ source_currency: 'INR', destination_currency: 'INR' }),
      pushBody({ effective_rate: 0 }),
      pushBody({ effective_rate: -5 }),
      pushBody({ effective_rate: 100_000 }), // exclusive upper bound
      pushBody({ effective_rate: 'nope' }),
      pushBody({ effective_rate: undefined }),
      pushBody({ ttl_seconds: 'soon' }),
    ];
    for (const body of bad) {
      // Wrap the body in the asserted object so a failure names the offending case.
      const result = await pushPartnerRate(deps, ACME, 'pk_1', body);
      expect({ body, result }).toMatchObject({ body, result: { ok: false, status: 400 } });
    }
    expect(await repo.getRate('acme', 'USD', 'INR')).toBeNull(); // nothing persisted
  });

  it("NEVER writes another partner's row — identity comes from the key, not the body", async () => {
    const { deps, repo } = await harness();
    // A hostile body partner_id is ignored entirely.
    const r = await pushPartnerRate(deps, ACME, 'pk_1', pushBody({ partner_id: 'globex' }));
    expect(r).toMatchObject({ ok: true });
    expect(await repo.getRate('acme', 'USD', 'INR')).not.toBeNull();
    expect(await repo.getRate('globex', 'USD', 'INR')).toBeNull();
    expect(await repo.listRatesForPartner('globex')).toHaveLength(0);
  });

  it('a push PRESERVES the admin-configured margin (merge upsert)', async () => {
    const { deps, repo } = await harness();
    await repo.upsertRate({
      id: 'm1', partnerId: 'acme', sourceCurrency: 'USD', destinationCurrency: 'INR', marginBps: 40,
    });
    const r = await pushPartnerRate(deps, ACME, 'pk_1', pushBody());
    expect(r).toMatchObject({ ok: true });
    const stored = await repo.getRate('acme', 'USD', 'INR');
    expect(stored).toMatchObject({ marginBps: 40, effectiveRate: 86.4, expiresAt: atSeconds(3600) });
  });
});

describe('listPartnerRates (GET /rates)', () => {
  it("lists ONLY the partner's own rates with `fresh` computed per record", async () => {
    const { deps, repo } = await harness();
    // Fresh push (via the service), an EXPIRED push, and a margin-only record.
    await pushPartnerRate(deps, ACME, 'pk_1', pushBody({ ttl_seconds: 1800 }));
    await repo.upsertRate({
      id: 'old', partnerId: 'acme', sourceCurrency: 'GBP', destinationCurrency: 'INR',
      effectiveRate: 110.2, expiresAt: atSeconds(-60), pushedAt: atSeconds(-7200),
    });
    await repo.upsertRate({
      id: 'mar', partnerId: 'acme', sourceCurrency: 'AED', destinationCurrency: 'INR', marginBps: 25,
    });
    // Another tenant's rate must never appear.
    await repo.upsertRate({
      id: 'oth', partnerId: 'globex', sourceCurrency: 'USD', destinationCurrency: 'INR',
      effectiveRate: 99, expiresAt: atSeconds(1800),
    });

    const r = await listPartnerRates(deps, 'acme');
    expect(r).toMatchObject({ ok: true, status: 200 });
    if (!r.ok) throw new Error('unexpected');
    const { rates } = r.data as { rates: Record<string, unknown>[] };
    expect(rates).toHaveLength(3); // ordered by source currency: AED, GBP, USD
    expect(rates[0]).toEqual({
      source_currency: 'AED', destination_currency: 'INR',
      effective_rate: null, expires_at: null, fresh: false, margin_bps: 25,
    });
    expect(rates[1]).toMatchObject({ source_currency: 'GBP', effective_rate: 110.2, fresh: false });
    expect(rates[2]).toMatchObject({ source_currency: 'USD', effective_rate: 86.4, fresh: true, margin_bps: null });
  });

  it('an empty sheet is an empty array', async () => {
    const { deps } = await harness();
    const r = await listPartnerRates(deps, 'acme');
    expect(r).toMatchObject({ ok: true, status: 200 });
    if (r.ok) expect((r.data as { rates: unknown[] }).rates).toEqual([]);
  });
});
