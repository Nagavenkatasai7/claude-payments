import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { customers } from '@/db/schema';
import { decryptField } from '@/lib/field-crypto';
import { customerEmailCtx } from '@/lib/crypto-context';
import { createCustomerStore } from '@/lib/customer-store';
import type { Store } from '@/lib/store';
import {
  clearEmailVerification,
  emailVerifiedTag,
  getPortalPrefs,
  markEmailVerified,
  setEmailReceipts,
} from '@/lib/portal-prefs';
import {
  consumeEmailVerifyToken,
  isPortalEmailToken,
  maskEmail,
  mintEmailVerifyToken,
  normalizePortalEmail,
  PORTAL_EMAIL_TOKEN_TTL_S,
  portalEmailVerifyUrl,
} from '@/lib/portal-email-verify';
import { freshDb, seedPartner, seedSender } from './helpers-db';
import { fakeRedis, type FakeRedis } from './helpers';

// UI redesign M2-11, Task 11.4 (library half): the email address writer, the prefs writers and the
// single-use verify token. The token is 256-bit, stored only as sha256 in Redis (`pev:<hash>`),
// bound to (partner, phone, email tag), 24 h, and consumed with get → compare → getdel, so a wrong
// host or wrong customer never burns the owner's token.

const PHONE = '14155550123';
const EMAIL = 'user@example.com';

describe('normalizePortalEmail', () => {
  it('accepts a plain address, trimmed', () => {
    expect(normalizePortalEmail('  user@example.com ')).toBe('user@example.com');
  });
  it('refuses non-strings, empty, no @, no dot in the domain, spaces, line breaks and > 254 chars', () => {
    for (const bad of [undefined, null, 5, '', 'user', 'user@', '@example.com', 'user@example', 'us er@example.com', 'user@example.com\r\nBcc: x@example.com', 'a,b@example.com', '<user@example.com>']) {
      expect(normalizePortalEmail(bad)).toBeNull();
    }
    const long = `${'a'.repeat(250)}@example.com`;
    expect(long.length).toBeGreaterThan(254);
    expect(normalizePortalEmail(long)).toBeNull();
  });
});

describe('maskEmail', () => {
  it('keeps the first character and the domain only', () => {
    expect(maskEmail('user@example.com')).toBe('u•••@example.com');
    expect(maskEmail('u@example.com')).toBe('•••@example.com');
  });
  it('an unparseable value is fully masked', () => {
    expect(maskEmail('garbage')).toBe('•••');
  });
});

describe('portalEmailVerifyUrl', () => {
  it("is on the partner's own host, with the token in the query only", () => {
    expect(portalEmailVerifyUrl('acme', 'tok_abc')).toBe('https://acme.smartremit.ai/portal/notifications/verify?token=tok_abc');
  });
  it('refuses an invalid or reserved slug', () => {
    expect(() => portalEmailVerifyUrl('www', 'x')).toThrow();
    expect(() => portalEmailVerifyUrl('evil.com/x', 'x')).toThrow();
  });
});

describe('verify token', () => {
  let redis: FakeRedis;
  const bind = (partnerId = 'pa', phone = PHONE, email = EMAIL) => ({ partnerId, phone, tag: emailVerifiedTag(partnerId, phone, email) });
  beforeEach(() => {
    redis = fakeRedis();
  });

  it('is 256-bit base64url, stored only under its sha256 with a 24 h TTL', async () => {
    const token = await mintEmailVerifyToken(redis, bind());
    expect(isPortalEmailToken(token)).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const key = `pev:${createHash('sha256').update(token).digest('hex')}`;
    const raw = redis.dump.get(key);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(EMAIL);
    expect(PORTAL_EMAIL_TOKEN_TTL_S).toBe(24 * 3600);
  });

  it('consumes once for the bound (partner, phone, tag)', async () => {
    const token = await mintEmailVerifyToken(redis, bind());
    expect(await consumeEmailVerifyToken(redis, token, bind())).toBe(true);
    expect(await consumeEmailVerifyToken(redis, token, bind())).toBe(false);
  });

  it("a token minted for A on partner X fails for partner Y or for another phone, and does NOT burn the owner's token", async () => {
    const token = await mintEmailVerifyToken(redis, bind('pa'));
    expect(await consumeEmailVerifyToken(redis, token, bind('pb'))).toBe(false);
    expect(await consumeEmailVerifyToken(redis, token, bind('pa', '14155550999'))).toBe(false);
    expect(await consumeEmailVerifyToken(redis, token, bind('pa'))).toBe(true);
  });

  it('a token for an old email fails once the address changed (the tag differs)', async () => {
    const token = await mintEmailVerifyToken(redis, bind('pa', PHONE, 'old@example.com'));
    expect(await consumeEmailVerifyToken(redis, token, bind('pa', PHONE, 'new@example.com'))).toBe(false);
  });

  it('a malformed token never reaches Redis', async () => {
    const before = redis.dump.size;
    for (const bad of ['', 'short', 'x'.repeat(44), 'a/b'.padEnd(43, 'a'), undefined as unknown as string]) {
      expect(await consumeEmailVerifyToken(redis, bad, bind())).toBe(false);
    }
    expect(redis.dump.size).toBe(before);
  });
});

describe('prefs writers + setEmail (tenant-keyed, single-column)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    for (const p of ['pa', 'pb']) {
      await seedPartner(db, p);
      await seedSender(db, { partnerId: p, phone: PHONE, kycStatus: 'verified' });
    }
  });

  it('markEmailVerified / clearEmailVerification / setEmailReceipts upsert ONE row and never touch the other tenant', async () => {
    const tag = emailVerifiedTag('pa', PHONE, EMAIL);
    await markEmailVerified(db, 'pa', PHONE, tag);
    let a = await getPortalPrefs(db, 'pa', PHONE);
    expect(a?.emailVerifiedTag).toBe(tag);
    expect(a?.emailVerifiedAt).toBeInstanceOf(Date);
    await setEmailReceipts(db, 'pa', PHONE, true);
    a = await getPortalPrefs(db, 'pa', PHONE);
    expect(a).toMatchObject({ emailReceipts: true, emailVerifiedTag: tag });
    await clearEmailVerification(db, 'pa', PHONE);
    a = await getPortalPrefs(db, 'pa', PHONE);
    expect(a).toMatchObject({ emailReceipts: true, emailVerifiedTag: null, emailVerifiedAt: null });
    expect(await getPortalPrefs(db, 'pb', PHONE)).toBeNull();
  });

  it('setEmail seals under customerEmailCtx and writes ONLY email_enc on the tenant row (KYC fields untouched)', async () => {
    const cs = createCustomerStore(db, { firstTransferAt: async () => null } as unknown as Store);
    const before = (await db.select().from(customers).where(eq(customers.partnerId, 'pa')))[0];
    expect(await cs.setEmail('pa', PHONE, EMAIL)).toBe(true);
    const after = (await db.select().from(customers).where(eq(customers.partnerId, 'pa')))[0];
    expect(decryptField(after.emailEnc!, undefined, customerEmailCtx({ partnerId: 'pa', senderPhone: PHONE }))).toBe(EMAIL);
    const { emailEnc: _a, updatedAt: _b, ...restAfter } = after;
    const { emailEnc: _c, updatedAt: _d, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    const other = (await db.select().from(customers).where(eq(customers.partnerId, 'pb')))[0];
    expect(other.emailEnc).toBeNull();
    expect(await cs.setEmail('pa', '14155550999', EMAIL)).toBe(false);
  });
});
