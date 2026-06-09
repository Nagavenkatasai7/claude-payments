import { describe, it, expect } from 'vitest';
import { authenticatePartner } from '@/lib/partner-api-auth';
import { createPartnerApiKeyStore } from '@/lib/partner-api-key';
import { fakeRedis } from './helpers';

function reqWith(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (n: string) => lower[n.toLowerCase()] ?? null } };
}

function keyStore(redis = fakeRedis()) {
  let n = 0;
  return createPartnerApiKeyStore(redis, {
    now: () => '2026-06-08T00:00:00Z',
    genSecret: () => `SECRET${n++}`,
    genKeyId: () => `pk_${n}`,
    pepper: 'p',
  });
}

describe('authenticatePartner', () => {
  it('401 when the Authorization header is missing or malformed', async () => {
    const store = keyStore();
    expect(await authenticatePartner(reqWith({}), store)).toMatchObject({ ok: false, status: 401 });
    expect(await authenticatePartner(reqWith({ authorization: 'token abc' }), store)).toMatchObject({ ok: false, status: 401 });
  });

  it('401 for an invalid / unknown key', async () => {
    const store = keyStore();
    const r = await authenticatePartner(reqWith({ authorization: 'Bearer sr_live_nope' }), store);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('derives partnerId FROM THE KEY (a body partnerId is irrelevant — never read)', async () => {
    const redis = fakeRedis();
    const store = keyStore(redis);
    const issued = await store.issue('acme');
    const r = await authenticatePartner(reqWith({ authorization: `Bearer ${issued.plaintext}` }), store);
    expect(r).toEqual({ ok: true, partnerId: 'acme', keyId: issued.keyId });
  });

  it('401 after the key is revoked', async () => {
    const redis = fakeRedis();
    const store = keyStore(redis);
    const issued = await store.issue('acme');
    await store.revoke(issued.keyId);
    expect(await authenticatePartner(reqWith({ authorization: `Bearer ${issued.plaintext}` }), store)).toMatchObject({ ok: false, status: 401 });
  });
});
