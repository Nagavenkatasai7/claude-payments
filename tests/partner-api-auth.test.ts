import { describe, it, expect, beforeEach } from 'vitest';
import { authenticatePartner } from '@/lib/partner-api-auth';
import { createPartnerApiKeyStore } from '@/lib/partner-api-key';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

function reqWith(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (n: string) => lower[n.toLowerCase()] ?? null } };
}

function keyStore(db: Db) {
  let n = 0;
  return createPartnerApiKeyStore(db, {
    now: () => new Date('2026-06-08T00:00:00Z'),
    genSecret: () => `SECRET${n++}`,
    genKeyId: () => `pk_${n}`,
    pepper: 'p',
  });
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
});

describe('authenticatePartner', () => {
  it('401 when the Authorization header is missing or malformed', async () => {
    const store = keyStore(db);
    expect(await authenticatePartner(reqWith({}), store)).toMatchObject({ ok: false, status: 401 });
    expect(await authenticatePartner(reqWith({ authorization: 'token abc' }), store)).toMatchObject({ ok: false, status: 401 });
  });

  it('401 for an invalid / unknown key', async () => {
    const store = keyStore(db);
    const r = await authenticatePartner(reqWith({ authorization: 'Bearer sr_live_nope' }), store);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('derives partnerId FROM THE KEY (a body partnerId is irrelevant — never read)', async () => {
    const store = keyStore(db);
    const issued = await store.issue('acme');
    const r = await authenticatePartner(reqWith({ authorization: `Bearer ${issued.plaintext}` }), store);
    expect(r).toEqual({ ok: true, partnerId: 'acme', keyId: issued.keyId });
  });

  it('401 after the key is revoked', async () => {
    const store = keyStore(db);
    const issued = await store.issue('acme');
    await store.revoke(issued.keyId);
    expect(await authenticatePartner(reqWith({ authorization: `Bearer ${issued.plaintext}` }), store)).toMatchObject({ ok: false, status: 401 });
  });
});
