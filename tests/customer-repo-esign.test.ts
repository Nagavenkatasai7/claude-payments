import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createCustomerRepo,
  readEsignConsent,
  recordEsignConsent,
  withdrawEsignConsent,
} from '@/db/repos/customer-repo';
import type { Db, DbOrTx } from '@/db/client';
import { esignConsentNeeded } from '@/lib/esign';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import { captureQueries, freshDb, seedPartner } from './helpers-db';

// Fix pack 6 T1 (P2): the customer's E-SIGN consent columns. READ-ONLY on Customer;
// the only writers are recordEsignConsent / withdrawEsignConsent; a whole-row save
// or insert never sets or clears them. Phones are invented placeholders.

const PHONE = '15551230611';
const OTHER = 'esign-other-tenant';
const V1 = 'esign-test-v1';
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

type Raw = { esign_consent_version: string | null; esign_consented_at: string | null; esign_withdrawn_at: string | null; updated_at: string };
async function raw(db: Db, partnerId: string, phone = PHONE): Promise<Raw | undefined> {
  const r = (await db.execute(sql.raw(
    `SELECT esign_consent_version, esign_consented_at::text, esign_withdrawn_at::text, updated_at::text
     FROM customers WHERE partner_id = '${partnerId}' AND phone = '${phone}'`,
  ))) as unknown as { rows: Raw[] };
  return r.rows[0];
}
const ms = (s: string | null) => (s === null ? null : new Date(s).getTime());

describe('customer E-SIGN consent repo (P2)', () => {
  let db: Db;
  let repo: ReturnType<typeof createCustomerRepo>;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, OTHER);
    repo = createCustomerRepo(db, async () => null);
  });

  it('readEsignConsent: null when the tenant has no row; all-null state for a fresh row; another tenant\'s row with the same phone is never read', async () => {
    expect(await readEsignConsent(db, 'default', PHONE)).toBeNull();
    await repo.ensureCustomer(OTHER, PHONE);
    expect(await recordEsignConsent(db, OTHER, PHONE, V1, minutesAgo(5))).toBe(true);
    expect(await readEsignConsent(db, 'default', PHONE)).toBeNull();
    await repo.ensureCustomer('default', PHONE);
    expect(await readEsignConsent(db, 'default', PHONE)).toEqual({ version: null, consentedAt: null, withdrawnAt: null });
    const other = await readEsignConsent(db, OTHER, PHONE);
    expect(other?.version).toBe(V1);
  });

  it('readEsignConsent throws on a DB error (no swallow)', async () => {
    const broken = { select: () => { throw new Error('db down'); } } as unknown as DbOrTx;
    await expect(readEsignConsent(broken, 'default', PHONE)).rejects.toThrow('db down');
  });

  it('recordEsignConsent: true and the row carries version, consented_at, withdrawn_at NULL, updated_at; false when absent; the other tenant is unchanged', async () => {
    const at = minutesAgo(3);
    expect(await recordEsignConsent(db, 'default', PHONE, V1, at)).toBe(false);
    expect(await raw(db, 'default')).toBeUndefined();
    await repo.ensureCustomer('default', PHONE);
    await repo.ensureCustomer(OTHER, PHONE);
    const otherBefore = await raw(db, OTHER);
    expect(await recordEsignConsent(db, 'default', PHONE, V1, at)).toBe(true);
    const r = (await raw(db, 'default'))!;
    expect(r.esign_consent_version).toBe(V1);
    expect(ms(r.esign_consented_at)).toBe(at.getTime());
    expect(r.esign_withdrawn_at).toBeNull();
    expect(ms(r.updated_at)).toBe(at.getTime());
    expect(await raw(db, OTHER)).toEqual(otherBefore);
    expect(await readEsignConsent(db, 'default', PHONE)).toEqual({ version: V1, consentedAt: at, withdrawnAt: null });
  });

  it('recordEsignConsent after a withdrawal clears withdrawn_at (re-consent)', async () => {
    await repo.ensureCustomer('default', PHONE);
    await recordEsignConsent(db, 'default', PHONE, V1, minutesAgo(10));
    expect(await withdrawEsignConsent(db, 'default', PHONE, minutesAgo(8))).toBe(V1);
    const again = minutesAgo(2);
    expect(await recordEsignConsent(db, 'default', PHONE, 'esign-test-v2', again)).toBe(true);
    expect(await readEsignConsent(db, 'default', PHONE)).toEqual({ version: 'esign-test-v2', consentedAt: again, withdrawnAt: null });
  });

  // Final check X1: a pay-page consent's `at` is taken before its evidence transaction opens,
  // so a portal withdrawal stamped AFTER `at` can commit first. The consent write keeps it.
  it('recordEsignConsent keeps a withdrawal that is newer than its own time (consent still needed)', async () => {
    await repo.ensureCustomer('default', PHONE);
    const t0 = Date.now();
    await recordEsignConsent(db, 'default', PHONE, ESIGN_CONSENT_VERSION, new Date(t0 - 60_000));
    const withdrawnAt = new Date(t0 + 300);
    expect(await withdrawEsignConsent(db, 'default', PHONE, withdrawnAt)).toBe(ESIGN_CONSENT_VERSION);
    expect(await recordEsignConsent(db, 'default', PHONE, ESIGN_CONSENT_VERSION, new Date(t0))).toBe(true);
    const s = await readEsignConsent(db, 'default', PHONE);
    expect(s).toEqual({ version: ESIGN_CONSENT_VERSION, consentedAt: new Date(t0), withdrawnAt });
    expect(esignConsentNeeded(s)).toBe(true);
  });

  it('recordEsignConsent at a time after the withdrawal clears it (consent not needed)', async () => {
    await repo.ensureCustomer('default', PHONE);
    const t0 = Date.now();
    await recordEsignConsent(db, 'default', PHONE, ESIGN_CONSENT_VERSION, new Date(t0 - 60_000));
    await withdrawEsignConsent(db, 'default', PHONE, new Date(t0 + 300));
    const later = new Date(t0 + 1_000);
    expect(await recordEsignConsent(db, 'default', PHONE, ESIGN_CONSENT_VERSION, later)).toBe(true);
    const s = await readEsignConsent(db, 'default', PHONE);
    expect(s).toEqual({ version: ESIGN_CONSENT_VERSION, consentedAt: later, withdrawnAt: null });
    expect(esignConsentNeeded(s)).toBe(false);
  });

  it('withdrawEsignConsent returns the version and stamps withdrawn_at, never earlier than consented_at', async () => {
    await repo.ensureCustomer('default', PHONE);
    const consented = minutesAgo(5);
    await recordEsignConsent(db, 'default', PHONE, V1, consented);
    const early = new Date(consented.getTime() - 60_000); // clock skew: one minute BEFORE the consent
    expect(await withdrawEsignConsent(db, 'default', PHONE, early)).toBe(V1);
    const r = (await raw(db, 'default'))!;
    expect(ms(r.esign_withdrawn_at)).toBeGreaterThanOrEqual(consented.getTime());
    expect(ms(r.esign_withdrawn_at)).toBe(consented.getTime());
    expect(ms(r.updated_at)).toBe(early.getTime());

    await repo.ensureCustomer(OTHER, PHONE);
    await recordEsignConsent(db, OTHER, PHONE, V1, minutesAgo(5));
    const later = minutesAgo(1);
    expect(await withdrawEsignConsent(db, OTHER, PHONE, later)).toBe(V1);
    expect(ms((await raw(db, OTHER))!.esign_withdrawn_at)).toBe(later.getTime());
  });

  it('withdrawEsignConsent returns null and writes nothing when nothing is on file', async () => {
    // No row.
    expect(await withdrawEsignConsent(db, 'default', PHONE, minutesAgo(1))).toBeNull();
    expect(await raw(db, 'default')).toBeUndefined();
    // A row never consented.
    await repo.ensureCustomer('default', PHONE);
    const fresh = await raw(db, 'default');
    expect(await withdrawEsignConsent(db, 'default', PHONE, minutesAgo(1))).toBeNull();
    expect(await raw(db, 'default')).toEqual(fresh);
    // Already withdrawn.
    await recordEsignConsent(db, 'default', PHONE, V1, minutesAgo(10));
    await withdrawEsignConsent(db, 'default', PHONE, minutesAgo(8));
    const withdrawn = await raw(db, 'default');
    expect(await withdrawEsignConsent(db, 'default', PHONE, minutesAgo(1))).toBeNull();
    expect(await raw(db, 'default')).toEqual(withdrawn);
  });

  it('getCustomer maps the three as ISO strings; absent (not null) when NULL', async () => {
    await repo.ensureCustomer('default', PHONE);
    const before = (await repo.getCustomer('default', PHONE))!;
    expect('esignConsentVersion' in before).toBe(false);
    expect('esignConsentedAt' in before).toBe(false);
    expect('esignWithdrawnAt' in before).toBe(false);
    const consented = minutesAgo(5);
    const withdrawn = minutesAgo(2);
    await recordEsignConsent(db, 'default', PHONE, V1, consented);
    const on = (await repo.getCustomer('default', PHONE))!;
    expect(on.esignConsentVersion).toBe(V1);
    expect(on.esignConsentedAt).toBe(consented.toISOString());
    expect('esignWithdrawnAt' in on).toBe(false);
    await withdrawEsignConsent(db, 'default', PHONE, withdrawn);
    expect((await repo.getCustomer('default', PHONE))!.esignWithdrawnAt).toBe(withdrawn.toISOString());
  });

  it('saveCustomer never sets or clears consent; nor do the insert paths', async () => {
    await repo.ensureCustomer('default', PHONE);
    const stale = (await repo.getCustomer('default', PHONE))!;
    await recordEsignConsent(db, 'default', PHONE, V1, minutesAgo(5));
    const onFile = await raw(db, 'default');
    const consent = (r: Raw | undefined) => [r?.esign_consent_version, r?.esign_consented_at, r?.esign_withdrawn_at];

    const stop = captureQueries();
    await repo.saveCustomer({ ...stale, occupation: 'salaried', updatedAt: new Date().toISOString() });
    const queries = stop();
    expect(consent(await raw(db, 'default'))).toEqual(consent(onFile));
    const insert = queries.find((q) => /^insert into "customers"/i.test(q.sql));
    expect(insert).toBeDefined();
    // drizzle lists EVERY schema column in an INSERT and sends `default` for the ones the row
    // object leaves out (as for screening_flagged_at), so the guarantee is: each consent column
    // gets `default` in VALUES, and the ON CONFLICT DO UPDATE SET never names it.
    const m = /^insert into "customers" \((.*?)\) values \((.*?)\) on conflict .*? do update set (.*)$/is.exec(insert!.sql);
    expect(m).not.toBeNull();
    const cols = m![1].split(',').map((s) => s.trim().replace(/"/g, ''));
    const vals = m![2].split(',').map((s) => s.trim());
    expect(cols).toHaveLength(vals.length);
    for (const col of ['esign_consent_version', 'esign_consented_at', 'esign_withdrawn_at']) {
      expect(cols).toContain(col);
      expect(vals[cols.indexOf(col)]).toBe('default');
      expect(m![3]).not.toContain(col);
    }

    await repo.saveCustomer({
      ...stale,
      esignConsentVersion: 'other',
      esignConsentedAt: minutesAgo(1).toISOString(),
      esignWithdrawnAt: minutesAgo(1).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(consent(await raw(db, 'default'))).toEqual(consent(onFile));

    expect(await repo.insertCustomerIfAbsent({ ...stale, esignConsentVersion: 'other' })).toBe(false);
    await repo.ensureCustomer('default', PHONE);
    await repo.upsertOnFirstInbound('default', PHONE);
    expect(consent(await raw(db, 'default'))).toEqual(consent(onFile));
  });
});
