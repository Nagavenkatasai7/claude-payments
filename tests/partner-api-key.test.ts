import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { createPartnerApiKeyStore } from '@/lib/partner-api-key';
import { ALL_SCOPES, keyModeFromId, scopesForMode } from '@/lib/partner-api-scopes';
import { apiKeys } from '@/db/schema';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// Deterministic generators so we can assert exact plaintexts/ids.
function store(db: Db, seed = 'AAAA1111') {
  let n = 0;
  return createPartnerApiKeyStore(db, {
    now: () => new Date('2026-06-08T00:00:00Z'),
    genSecret: () => `${seed}${n++}`,
    genKeyId: () => `pk_${seed}${n}`,
    pepper: 'test-pepper',
  });
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  await seedPartner(db, 'globex');
});

describe('partner-api-key store', () => {
  it('issue returns a prefixed plaintext + keyId + last4; authenticate resolves the partner', async () => {
    const s = store(db);
    const issued = await s.issue('acme');
    expect(issued.plaintext.startsWith('sr_live_')).toBe(true);
    expect(issued.keyId.startsWith('pk_live_')).toBe(true);
    expect(issued.last4).toBe(issued.plaintext.slice(-4));
    expect(await s.authenticate(issued.plaintext)).toEqual({
      partnerId: 'acme', keyId: issued.keyId, mode: 'live', scopes: [...ALL_SCOPES],
    });
  });

  it('stores ONLY a hash at rest — the plaintext never appears in any stored value', async () => {
    const s = store(db);
    const issued = await s.issue('acme');
    const raw = await db.execute(sql.raw('SELECT * FROM api_keys'));
    const rows = (raw as unknown as { rows: unknown[] }).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(issued.plaintext);
  });

  it('rejects an unknown or non-prefixed key', async () => {
    const s = store(db);
    await s.issue('acme');
    expect(await s.authenticate('sr_live_does_not_exist')).toBeNull();
    expect(await s.authenticate('not-even-a-key')).toBeNull();
    expect(await s.authenticate('')).toBeNull();
  });

  it('revoke makes the key fail authentication (idempotent)', async () => {
    const s = store(db);
    const issued = await s.issue('acme');
    expect(await s.revoke(issued.keyId)).toBe(true);
    expect(await s.authenticate(issued.plaintext)).toBeNull();
    expect(await s.revoke(issued.keyId)).toBe(true); // idempotent
    expect(await s.revoke('pk_nope')).toBe(false);
  });

  it('list returns public fields only (no hash, no plaintext) and is partner-scoped', async () => {
    const s = store(db);
    const a = await s.issue('acme');
    await s.issue('acme');
    const list = await s.list('acme');
    expect(list).toHaveLength(2);
    for (const k of list) {
      expect(k).toHaveProperty('keyId');
      expect(k).toHaveProperty('last4');
      expect(k).not.toHaveProperty('hash');
      expect(JSON.stringify(k)).not.toContain(a.plaintext);
    }
    expect(await s.list('globex')).toEqual([]); // other partner sees nothing
  });

  it('CROSS-TENANT: partner A\'s key never authenticates as partner B', async () => {
    const s = store(db);
    const aKey = await s.issue('acme');
    const bKey = await s.issue('globex');
    expect((await s.authenticate(aKey.plaintext))!.partnerId).toBe('acme');
    expect((await s.authenticate(bKey.plaintext))!.partnerId).toBe('globex');
    // A's key id is not in B's set and vice-versa
    expect((await s.list('acme')).some((k) => k.keyId === bKey.keyId)).toBe(false);
  });

  // ── Program-Fix 44 P1: key modes ────────────────────────────────────────
  it('issue(partner, "test") mints sr_test_ / pk_test_ and authenticates as test with the 3 test scopes', async () => {
    const s = store(db);
    const issued = await s.issue('acme', 'test');
    expect(issued.plaintext.startsWith('sr_test_')).toBe(true);
    expect(issued.keyId.startsWith('pk_test_')).toBe(true);
    expect(await s.authenticate(issued.plaintext)).toEqual({
      partnerId: 'acme', keyId: issued.keyId, mode: 'test', scopes: scopesForMode('test'),
    });
  });

  it('the key id always encodes the mode (even with an injected id generator) — one display rule', async () => {
    const s = store(db);
    for (const mode of ['live', 'test'] as const) {
      const issued = await s.issue('acme', mode);
      const auth = await s.authenticate(issued.plaintext);
      expect(auth!.mode).toBe(mode);
      expect(keyModeFromId(issued.keyId)).toBe(mode);
      expect(issued.plaintext.startsWith(`sr_${mode}_`)).toBe(true);
    }
  });

  it('the mode cannot be forged: flipping a key\'s prefix never authenticates', async () => {
    const s = store(db);
    const live = await s.issue('acme');
    const test = await s.issue('acme', 'test');
    expect(await s.authenticate(live.plaintext.replace('sr_live_', 'sr_test_'))).toBeNull();
    expect(await s.authenticate(test.plaintext.replace('sr_test_', 'sr_live_'))).toBeNull();
  });

  it('PINNED (owner decision A1): a pre-fix key — legacy pk_<id> + sr_live_ plaintext — is live with FULL scope', async () => {
    // Inserted directly, exactly as a pre-fix build stored it (issue() would
    // now write a pk_live_ id). Same hash expression as the repo.
    const plaintext = 'sr_live_LEGACYsecretAAAABBBBCCCCDDDD';
    await db.insert(apiKeys).values({
      id: 'pk_LegacyId0123456789ab',
      partnerId: 'acme',
      keyHash: createHash('sha256').update(`${plaintext}test-pepper`).digest('hex'),
      last4: plaintext.slice(-4),
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });
    const s = store(db);
    expect(await s.authenticate(plaintext)).toEqual({
      partnerId: 'acme', keyId: 'pk_LegacyId0123456789ab', mode: 'live', scopes: [...ALL_SCOPES],
    });
    expect(keyModeFromId('pk_LegacyId0123456789ab')).toBe('live');
  });
});
