import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { createCustomerStore } from '@/lib/customer-store';
import { EnvKeyProvider } from '@/lib/field-crypto';
import { fakeRedis } from './helpers';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';
import { resetRateCacheForTests } from '@/lib/rate';
import { createTransaction, resetSenderNameDeprecationLogForTests, type PartnerApiDeps } from '@/lib/partner-api-service';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import type { Partner } from '@/lib/types';

// Fix pack 5 T24 (P23): the Partner API's optional sender.address and sender.date_of_birth.
// Validated before the customer write and the Idempotency-Key claim (400); with a LIVE key the
// valid values are written set-if-unset on the partner's customer AFTER a fresh (non-replayed)
// mint, with ONE customer.travel_rule_set audit row; a test key validates and ignores them; a
// replay, a 409 and a refused mint store nothing; a write failure never undoes the mint.

vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));
const origSeam = { throwWrite: false, writes: 0 };
vi.mock('@/lib/originator-info', async (orig) => {
  const real = await orig<typeof import('@/lib/originator-info')>();
  return {
    ...real,
    writeOriginatorInfo: async (...a: Parameters<typeof real.writeOriginatorInfo>) => {
      origSeam.writes++;
      if (origSeam.throwWrite) {
        const e = new Error('write failed 1 Fixture Road');
        e.name = 'OriginatorWriteDown';
        throw e;
      }
      return real.writeOriginatorInfo(...a);
    },
  };
});

const NOW = new Date().toISOString();
const PHONE = '15551230000';
const ADDRESS = '1 Fixture Road, Testtown 00000';
const DOB = new Date(Date.now() - 40 * 365.25 * 86_400_000).toISOString().slice(0, 10);

async function harness(keyMode: 'live' | 'test' = 'live') {
  const redis = fakeRedis();
  const db = await freshDb();
  await seedPartner(db, 'acme');
  const store = createStore(redis, db);
  const customerStore = createCustomerStore(db, store);
  let n = 0;
  const deps: PartnerApiDeps = {
    store,
    customerStore,
    partnerStore: createPartnerStore(db),
    monthlyVolumeStore: createMonthlyVolumeStore(store),
    integrationsStore: createPartnerIntegrationsStore(db, new EnvKeyProvider(Buffer.alloc(32, 7))),
    db,
    keyMode,
    now: () => NOW,
    genId: () => `b${n++}`,
    initiatePayment: async () => {},
  };
  return { deps, db, store };
}

const DELEGATED: Partner = {
  id: 'acme', name: 'Acme', countries: ['US'], status: 'active', createdAt: NOW, updatedAt: NOW,
  displayName: 'Acme Pay', kycMode: 'delegated', requireKycBeforeSend: false,
} as Partner;

const txBody = (sender: Record<string, unknown> = {}) => ({
  amount_source: 200,
  sender: { phone: PHONE, name: 'Sender', kyc_status: 'not_started', ...sender },
  beneficiary: { name: 'Anita', phone: '919876543210', payout_method: 'bank', payout_destination: '1234567890' },
  purpose: 'family_support',
});

function frankfurterStub(url: string) {
  const rates = String(url).includes('from=USD') ? { INR: 85.2 } : { USD: 1.27, INR: 108.2 };
  return { ok: true, json: async () => ({ rates }), text: async () => '' };
}

let logLines: string[];
beforeEach(() => {
  resetRateCacheForTests();
  resetSenderNameDeprecationLogForTests();
  origSeam.throwWrite = false;
  origSeam.writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => frankfurterStub(url)));
  logLines = [];
  for (const fn of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, fn).mockImplementation((...a: unknown[]) => void logLines.push(a.map(String).join(' ')));
  }
});
afterEach(() => vi.restoreAllMocks());

async function travelAudits(db: Awaited<ReturnType<typeof freshDb>>) {
  const r = await db.execute(
    sql`SELECT actor, actor_type, subject_id, meta FROM audit_events WHERE action = 'customer.travel_rule_set' ORDER BY id`,
  );
  return r.rows as Array<{ actor: string; actor_type: string; subject_id: string; meta: Record<string, unknown> }>;
}
async function customerRows(db: Awaited<ReturnType<typeof freshDb>>) {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM customers WHERE partner_id = 'acme'`);
  return (r.rows[0] as { n: number }).n;
}
const onFile = (db: Awaited<ReturnType<typeof freshDb>>) => createCustomerRepo(db, async () => null).originatorOnFile('acme', PHONE);

describe('Partner API sender.address / sender.date_of_birth (pack 5 T24)', { retry: 0 }, () => {
  it('live key, valid values -> 201; both sealed on the customer; ONE audit row (api key actor, transferId)', async () => {
    const { deps, db } = await harness();
    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-o1', txBody({ address: ADDRESS, date_of_birth: DOB }));
    expect(r).toMatchObject({ ok: true, status: 201 });
    if (!r.ok) throw new Error('unexpected');
    const id = (r.data as { id: string }).id;
    expect(await onFile(db)).toEqual({ address: true, dateOfBirth: true });
    // Sealed: the plaintext is nowhere in the row.
    const raw = await db.execute(sql`SELECT residential_address_enc, date_of_birth_enc FROM customers WHERE partner_id = 'acme' AND phone = ${PHONE}`);
    expect(JSON.stringify(raw.rows)).not.toContain(ADDRESS);
    expect(JSON.stringify(raw.rows)).not.toContain(DOB);
    const audits = await travelAudits(db);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: 'pk_1',
      actor_type: 'api_key',
      meta: { source: 'partner_api', fields: ['address', 'date_of_birth'], transferId: id },
    });
    expect(Object.keys(audits[0].meta).sort()).toEqual(['fields', 'source', 'transferId']);
  });

  it.each([
    ['address 12345 (not a string)', { address: 12345 }, 'sender.address is invalid.'],
    ['address empty', { address: '' }, 'sender.address is invalid.'],
    ['address 301 chars', { address: 'a'.repeat(301) }, 'sender.address is invalid.'],
    ['dob in the future', { date_of_birth: '2099-01-01' }, 'sender.date_of_birth is invalid.'],
    ['dob not a date', { date_of_birth: '1990-13-01' }, 'sender.date_of_birth is invalid.'],
    ['dob a number', { date_of_birth: 19900101 }, 'sender.date_of_birth is invalid.'],
  ])('%s -> 400 before the customer write and the claim; a corrected retry mints', async (_l, extra, msg) => {
    const { deps, db } = await harness();
    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-bad', txBody(extra));
    expect(r).toEqual({ ok: false, status: 400, error: msg });
    expect(await customerRows(db)).toBe(0);
    expect(await createIdempotencyRepo(db).find('acme', 'idem-bad')).toBeNull();
    const fixed = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-bad', txBody());
    expect(fixed).toMatchObject({ ok: true, status: 201 });
  });

  it('values already on file: a different value is ignored (set-if-unset), no audit row', async () => {
    const { deps, db } = await harness();
    await createTransaction(deps, DELEGATED, 'pk_1', 'idem-a', txBody({ address: ADDRESS, date_of_birth: DOB }));
    expect(await travelAudits(db)).toHaveLength(1);
    const repo = createCustomerRepo(db, async () => null);
    const before = await db.execute(sql`SELECT residential_address_enc, date_of_birth_enc FROM customers WHERE partner_id = 'acme' AND phone = ${PHONE}`);
    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-b', txBody({ address: '2 Other Lane, Elsewhere', date_of_birth: '1970-01-01' }));
    expect(r).toMatchObject({ ok: true, status: 201 });
    const after = await db.execute(sql`SELECT residential_address_enc, date_of_birth_enc FROM customers WHERE partner_id = 'acme' AND phone = ${PHONE}`);
    expect(after.rows).toEqual(before.rows);
    expect(await travelAudits(db)).toHaveLength(1);
    expect(await repo.originatorOnFile('acme', PHONE)).toEqual({ address: true, dateOfBirth: true });
  });

  it('test key: valid values are validated and ignored (no customers row, no audit row); invalid ones still 400', async () => {
    const { deps, db } = await harness('test');
    const r = await createTransaction(deps, DELEGATED, 'pk_t', 'idem-t', txBody({ address: ADDRESS, date_of_birth: DOB }));
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(await customerRows(db)).toBe(0);
    expect(await travelAudits(db)).toEqual([]);
    expect(origSeam.writes).toBe(0);
    expect(await createTransaction(deps, DELEGATED, 'pk_t', 'idem-t2', txBody({ address: '' }))).toMatchObject({ ok: false, status: 400 });
    expect(await createTransaction(deps, DELEGATED, 'pk_t', 'idem-t3', txBody({ date_of_birth: 'x' }))).toMatchObject({ ok: false, status: 400 });
  });

  it('absent keys (and explicit nulls): the same response as without them, no write, no audit row', async () => {
    const a = await harness();
    const plain = await createTransaction(a.deps, DELEGATED, 'pk_1', 'idem-p', txBody());
    const b = await harness();
    const nulls = await createTransaction(b.deps, DELEGATED, 'pk_1', 'idem-p', txBody({ address: null, date_of_birth: null }));
    // created_at is the mint's wall-clock time (two separate mints); every other byte is equal.
    const norm = (x: unknown) => JSON.stringify(x).replace(/"created_at":"[^"]*"/g, '"created_at":"<t>"');
    expect(norm(nulls)).toBe(norm(plain));
    expect(origSeam.writes).toBe(0);
    expect(await travelAudits(a.db)).toEqual([]);
    expect(await travelAudits(b.db)).toEqual([]);
    expect(await onFile(a.db)).toEqual({ address: false, dateOfBirth: false });
  });

  it('a replay of the same key that now carries sender.address writes nothing and adds no audit row', async () => {
    const { deps, db } = await harness();
    expect(await createTransaction(deps, DELEGATED, 'pk_1', 'idem-r', txBody())).toMatchObject({ status: 201 });
    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-r', txBody({ address: ADDRESS }));
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(await onFile(db)).toEqual({ address: false, dateOfBirth: false });
    expect(await travelAudits(db)).toEqual([]);
    expect(origSeam.writes).toBe(0);
  });

  it('a 409 cross-environment conflict writes nothing', async () => {
    const { deps, db } = await harness('test');
    const t = await createTransaction(deps, DELEGATED, 'pk_t', 'idem-x', txBody());
    if (!t.ok) throw new Error('unexpected');
    const testId = (t.data as { id: string }).id;
    // The live namespace key bound to the sandbox row (the shape the sameEnv check refuses).
    await createIdempotencyRepo(db).claim('acme', 'idem-x', testId);
    const live: PartnerApiDeps = { ...deps, keyMode: 'live' };
    const before = await customerRows(db);
    const r = await createTransaction(live, DELEGATED, 'pk_1', 'idem-x', txBody({ address: ADDRESS }));
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(await onFile(db)).toEqual({ address: false, dateOfBirth: false });
    expect(await customerRows(db)).toBe(before + 1); // ensureCustomer only (as today), no address
    expect(await travelAudits(db)).toEqual([]);
    expect(origSeam.writes).toBe(0);
  });

  it('a concurrent loser that replays the winner (replayed === true) writes nothing', async () => {
    const { deps, db } = await harness();
    const first = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-race', txBody());
    if (!first.ok) throw new Error('unexpected');
    vi.spyOn(deps.store, 'getTransfer').mockResolvedValueOnce(null);
    const loser = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-race', txBody({ address: ADDRESS, date_of_birth: DOB }));
    expect(loser.ok && (loser.data as { id: string }).id).toBe((first.data as { id: string }).id);
    expect(await onFile(db)).toEqual({ address: false, dateOfBirth: false });
    expect(await travelAudits(db)).toEqual([]);
    expect(origSeam.writes).toBe(0);
  });

  it('a mint refused after the claim (SendCapError 422) writes nothing', async () => {
    const { deps, db } = await harness();
    await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 400 }); // T0 $500/day
    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-cap', txBody({ address: ADDRESS, date_of_birth: DOB }));
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(await onFile(db)).toEqual({ address: false, dateOfBirth: false });
    expect(await travelAudits(db)).toEqual([]);
    expect(origSeam.writes).toBe(0);
  });

  it('writeOriginatorInfo throws after the mint: still 201 with the row; the error NAME logged; no value logged', async () => {
    const { deps, db, store } = await harness();
    origSeam.throwWrite = true;
    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-w', txBody({ address: ADDRESS, date_of_birth: DOB }));
    expect(r).toMatchObject({ ok: true, status: 201 });
    if (!r.ok) throw new Error('unexpected');
    const id = (r.data as { id: string }).id;
    expect(await store.getTransfer(id)).not.toBeNull();
    expect(origSeam.writes).toBe(1);
    const line = logLines.find((l) => l.includes('partner-api.originator-write'));
    expect(line).toBeDefined();
    expect(line).toContain('OriginatorWriteDown');
    expect(line).toContain(id);
    expect(logLines.join('\n')).not.toContain('Fixture Road');
    expect(await travelAudits(db)).toEqual([]);
  });

  it('the values never appear in the response, a log line, the audit meta or an outbox payload', async () => {
    const { deps, db } = await harness();
    const r = await createTransaction(deps, DELEGATED, 'pk_1', 'idem-leak', txBody({ address: ADDRESS, date_of_birth: DOB }));
    expect(r).toMatchObject({ ok: true, status: 201 });
    const blob = [
      JSON.stringify(r),
      logLines.join('\n'),
      JSON.stringify((await db.execute(sql`SELECT meta FROM audit_events`)).rows),
      JSON.stringify((await db.execute(sql`SELECT payload, last_error FROM outbox`)).rows),
    ].join('\n');
    expect(blob).not.toContain(ADDRESS);
    expect(blob).not.toContain(DOB);
  });
});
