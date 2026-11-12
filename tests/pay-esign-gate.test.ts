import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createCustomerRepo, recordEsignConsent, withdrawEsignConsent } from '@/db/repos/customer-repo';
import type { Db, DbOrTx } from '@/db/client';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import { parsePayBody } from '@/lib/pay-body';
import { payEsignGate } from '@/lib/pay-esign-gate';
import { captureQueries, freshDb, seedPartner } from './helpers-db';

// Fix pack 6 T4 (P5): the E-SIGN gate of one pay POST, alone (no route wires it yet).
// Relative dates only; phones are invented placeholders.

const PHONE = '15551230644';
const OWNER = 'acme';
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

const bodyOf = (raw: Record<string, unknown>) => parsePayBody({ otp: '123456', ...raw }, 'transfer');
const ABSENT = bodyOf({});
const CURRENT = bodyOf({ esignConsentVersion: ESIGN_CONSENT_VERSION });
const STALE = bodyOf({ esignConsentVersion: 'esign-2020-01.1-draft' });
const EMPTY = bodyOf({ esignConsentVersion: '' });
const NON_STRING = bodyOf({ esignConsentVersion: 42 });

type Row = { esign_consent_version: string | null; esign_consented_at: string | null; esign_withdrawn_at: string | null; updated_at: string };
async function customerRow(db: Db, partnerId = OWNER, phone = PHONE): Promise<Row | undefined> {
  const r = (await db.execute(sql.raw(
    `SELECT esign_consent_version, esign_consented_at::text, esign_withdrawn_at::text, updated_at::text
     FROM customers WHERE partner_id = '${partnerId}' AND phone = '${phone}'`,
  ))) as unknown as { rows: Row[] };
  return r.rows[0];
}
async function auditCount(db: Db): Promise<number> {
  const r = (await db.execute(sql.raw('SELECT count(*)::int AS n FROM audit_events'))) as unknown as { rows: Array<{ n: number }> };
  return r.rows[0].n;
}

describe('payEsignGate (pack 6 P5)', () => {
  let db: Db;
  let repo: ReturnType<typeof createCustomerRepo>;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, OWNER);
    await seedPartner(db, 'beta');
    repo = createCustomerRepo(db, async () => null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exempt -> not_needed and NO customers query', async () => {
    const stop = captureQueries();
    const r = await payEsignGate(db, { ownerId: OWNER, phone: PHONE, exempt: true, body: ABSENT });
    const queries = stop();
    expect(r).toEqual({ kind: 'not_needed' });
    expect(queries.filter((q) => q.sql.includes('"customers"'))).toEqual([]);
  });

  it('exempt wins even when the owner is unresolved (no read, no log)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await payEsignGate(db, { ownerId: undefined, phone: PHONE, exempt: true, body: ABSENT })).toEqual({ kind: 'not_needed' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('ownerId undefined -> unavailable; one logWarn pay.esign-gate with the error name only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = captureQueries();
    const r = await payEsignGate(db, { ownerId: undefined, phone: PHONE, exempt: false, body: CURRENT });
    const queries = stop();
    expect(r).toEqual({ kind: 'unavailable' });
    expect(queries.filter((q) => q.sql.includes('"customers"'))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.scope).toBe('pay.esign-gate');
    expect(line).not.toContain(PHONE);
  });

  it('the consent read throws -> unavailable; logWarn pay.esign-gate { partnerId }, the error name only (never the message, never the phone)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    class SecretDbError extends Error {
      override name = 'SecretDbError';
    }
    const broken = {
      select: () => {
        throw new SecretDbError('connection to postgres://user:pw@host failed for 15551230644');
      },
    } as unknown as DbOrTx;
    const r = await payEsignGate(broken, { ownerId: OWNER, phone: PHONE, exempt: false, body: CURRENT });
    expect(r).toEqual({ kind: 'unavailable' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.scope).toBe('pay.esign-gate');
    expect(parsed.partnerId).toBe(OWNER);
    expect(line).toContain('SecretDbError');
    expect(line).not.toContain(PHONE);
    expect(line).not.toContain('postgres://');
    expect(line).not.toContain('connection to');
  });

  it('consent on file (current version) -> not_needed whatever the body carries (absent key, stale version, current version); nothing is written', async () => {
    await repo.ensureCustomer(OWNER, PHONE);
    await recordEsignConsent(db, OWNER, PHONE, ESIGN_CONSENT_VERSION, minutesAgo(5));
    const before = await customerRow(db);
    const audits = await auditCount(db);
    for (const body of [ABSENT, STALE, CURRENT, EMPTY, NON_STRING]) {
      const stop = captureQueries();
      expect(await payEsignGate(db, { ownerId: OWNER, phone: PHONE, exempt: false, body })).toEqual({ kind: 'not_needed' });
      const writes = stop().filter((q) => /^(insert|update|delete)\b/i.test(q.sql.trim()));
      expect(writes).toEqual([]);
    }
    expect(await customerRow(db)).toEqual(before);
    expect(await auditCount(db)).toBe(audits);
  });

  describe('consent needed', () => {
    const cases: Array<[string, (db: Db, repo: ReturnType<typeof createCustomerRepo>) => Promise<void>]> = [
      ['no customers row', async () => {}],
      ['a row without consent', async (_db, r) => { await r.ensureCustomer(OWNER, PHONE); }],
      ['a withdrawn consent', async (d, r) => {
        await r.ensureCustomer(OWNER, PHONE);
        await recordEsignConsent(d, OWNER, PHONE, ESIGN_CONSENT_VERSION, minutesAgo(10));
        await withdrawEsignConsent(d, OWNER, PHONE, minutesAgo(5));
      }],
      ['an older version on file', async (d, r) => {
        await r.ensureCustomer(OWNER, PHONE);
        await recordEsignConsent(d, OWNER, PHONE, 'esign-2020-01.1-draft', minutesAgo(10));
      }],
    ];

    for (const [name, setup] of cases) {
      it(`${name}: body.esignConsentVersion === ESIGN_CONSENT_VERSION -> { kind: 'consent', version: ESIGN_CONSENT_VERSION }`, async () => {
        await setup(db, repo);
        expect(await payEsignGate(db, { ownerId: OWNER, phone: PHONE, exempt: false, body: CURRENT })).toEqual({
          kind: 'consent',
          version: ESIGN_CONSENT_VERSION,
        });
      });

      it(`${name}: key absent -> reload_required; '' or a stale version or a non-string (parsed null) -> reload_required`, async () => {
        await setup(db, repo);
        expect(NON_STRING.esignConsentVersion).toBeNull();
        expect(NON_STRING.present.esignConsentVersion).toBe(true);
        for (const body of [ABSENT, EMPTY, STALE, NON_STRING]) {
          expect(await payEsignGate(db, { ownerId: OWNER, phone: PHONE, exempt: false, body })).toEqual({ kind: 'reload_required' });
        }
      });
    }
  });

  it("tenant scope: consent on file under partner 'beta' for the same phone does not count for owner 'acme'", async () => {
    await repo.ensureCustomer('beta', PHONE);
    await recordEsignConsent(db, 'beta', PHONE, ESIGN_CONSENT_VERSION, minutesAgo(5));
    expect(await payEsignGate(db, { ownerId: OWNER, phone: PHONE, exempt: false, body: ABSENT })).toEqual({ kind: 'reload_required' });
    expect(await payEsignGate(db, { ownerId: OWNER, phone: PHONE, exempt: false, body: CURRENT })).toEqual({
      kind: 'consent',
      version: ESIGN_CONSENT_VERSION,
    });
    expect(await payEsignGate(db, { ownerId: 'beta', phone: PHONE, exempt: false, body: ABSENT })).toEqual({ kind: 'not_needed' });
  });

  it('the gate never writes (consent case: the customers row is unchanged; no row is created)', async () => {
    await repo.ensureCustomer(OWNER, PHONE);
    const before = await customerRow(db);
    const audits = await auditCount(db);
    const stop = captureQueries();
    expect((await payEsignGate(db, { ownerId: OWNER, phone: PHONE, exempt: false, body: CURRENT })).kind).toBe('consent');
    expect((await payEsignGate(db, { ownerId: OWNER, phone: '15551230645', exempt: false, body: CURRENT })).kind).toBe('consent');
    const writes = stop().filter((q) => /^(insert|update|delete)\b/i.test(q.sql.trim()));
    expect(writes).toEqual([]);
    expect(await customerRow(db)).toEqual(before);
    expect(await customerRow(db, OWNER, '15551230645')).toBeUndefined();
    expect(await auditCount(db)).toBe(audits);
  });
});
