import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPartnerApiKeyStore } from '@/lib/partner-api-key';
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
    expect(issued.last4).toBe(issued.plaintext.slice(-4));
    expect(await s.authenticate(issued.plaintext)).toEqual({ partnerId: 'acme', keyId: issued.keyId });
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
});
