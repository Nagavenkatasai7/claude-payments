/**
 * Fix pack 5 T21a (R38, P19): originatorViewFor / readOriginatorView, the pay
 * page's and the pay route's view of which originator fields to ask. Only a
 * real-money b2c row that is neither exempt nor routed asks; the default
 * tenant, the simulator, the mock rail and a sandbox row make no customers
 * read. A read error never throws: required as computed, onFile false.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStore } from '@/lib/store';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { NO_ORIGINATOR_FIELDS, originatorViewFor, readOriginatorView, type OriginatorSubject } from '@/lib/originator-info';
import { fakeRedis } from './helpers';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import { seedRealMoneyRail, seedOriginatorForTest } from './helpers-live';
import type { Db } from '@/db/client';
import type { CountryCode, PartnerId, Transfer } from '@/lib/types';

const onFileFault = vi.hoisted(() => ({ throwOnRead: false }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  return {
    ...real,
    createCustomerRepo: (...a: Parameters<typeof real.createCustomerRepo>) => {
      const r = real.createCustomerRepo(...a);
      return {
        ...r,
        originatorOnFile: async (...b: Parameters<typeof r.originatorOnFile>) => {
          if (onFileFault.throwOnRead) throw new Error('on-file read failed');
          return r.originatorOnFile(...b);
        },
      };
    },
  };
});

const warns = vi.hoisted(() => [] as Array<{ scope: string; msg: unknown; fields: unknown }>);
vi.mock('@/lib/log', async (orig) => {
  const real = await orig<typeof import('@/lib/log')>();
  return {
    ...real,
    logWarn: (scope: string, msg: unknown, fields?: unknown) => {
      warns.push({ scope, msg, fields });
    },
  };
});

const ACME = 'acme' as PartnerId;
const PHONE = '15551230000';

let db: Db;
let store: ReturnType<typeof createStore>;

function subject(over: Partial<OriginatorSubject> = {}): OriginatorSubject {
  return { partnerId: ACME, phone: PHONE, amountUsd: 200, destinationCountry: 'IN', transferType: 'b2c', ...over };
}

async function row(over: Partial<Transfer> = {}): Promise<Transfer> {
  const t = {
    id: 'ov_t1', phone: PHONE, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Anita', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: new Date(Date.now() - 60_000).toISOString(), partnerId: ACME, environment: 'live',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205, transferType: 'b2c',
    ...over,
  } as Transfer;
  await store.saveTransfer(t);
  return t;
}

const customersQueried = (qs: Array<{ sql: string }>) => qs.some((q) => /"customers"/.test(q.sql));

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  await seedPartner(db, 'acme');
  await seedPartner(db, 'sim');
  onFileFault.throwOnRead = false;
  warns.length = 0;
});

describe('originatorViewFor / readOriginatorView (P19)', () => {
  it("not real money (default owner, simulator, mock, 'test'): nothing asked and NO customers query", async () => {
    await createIntegrationsRepo(db).saveIntegrations('sim' as PartnerId, {
      kyc: {}, whatsapp: {}, payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 's' }, webhookSecret: 'w' },
    } as never);
    await seedRealMoneyRail(db, ACME);
    const stop = captureQueries();
    const views = [
      await originatorViewFor(db, false, subject()),
      await readOriginatorView(db, { ownerId: 'default' as PartnerId, railPartnerId: ACME, environment: undefined, transferType: 'b2c', subject: subject({ partnerId: 'default' as PartnerId }) }),
      await readOriginatorView(db, { ownerId: 'sim' as PartnerId, railPartnerId: 'sim' as PartnerId, environment: undefined, transferType: 'b2c', subject: subject({ partnerId: 'sim' as PartnerId }) }),
      // acme without its own rail row would be mock: use a partner with no integrations row.
      await readOriginatorView(db, { ownerId: 'sim' as PartnerId, railPartnerId: 'nobody' as PartnerId, environment: 'live', transferType: 'b2c', subject: subject({ partnerId: 'sim' as PartnerId }) }),
      await readOriginatorView(db, { ownerId: ACME, railPartnerId: ACME, environment: 'test', transferType: 'b2c', subject: subject() }),
    ];
    const qs = stop();
    for (const v of views) {
      expect(v).toEqual({ addressRequired: false, addressOnFile: true, dobRequired: false, dobOnFile: true });
    }
    expect(customersQueried(qs)).toBe(false);
  });

  it('real money, b2c, no address on file, $200 to IN: address required not on file; DOB not required', async () => {
    expect(await originatorViewFor(db, true, subject())).toEqual({
      addressRequired: true, addressOnFile: false, dobRequired: false, dobOnFile: false,
    });
  });

  it('readOriginatorView on a real-money (http) rail of a non-default owner asks the address', async () => {
    await seedRealMoneyRail(db, ACME);
    const v = await readOriginatorView(db, { ownerId: ACME, railPartnerId: ACME, environment: undefined, transferType: 'b2c', subject: subject() });
    expect(v).toMatchObject({ addressRequired: true, addressOnFile: false, dobRequired: false });
  });

  it('real money, $1,500 to DE: DOB required too; $1,500 to IN: not; $3,000 to IN: both', async () => {
    const de = await originatorViewFor(db, true, subject({ amountUsd: 1500, destinationCountry: 'DE' as CountryCode }));
    expect(de).toMatchObject({ addressRequired: true, dobRequired: true });
    const inLow = await originatorViewFor(db, true, subject({ amountUsd: 1500 }));
    expect(inLow).toMatchObject({ addressRequired: true, dobRequired: false });
    const inHigh = await originatorViewFor(db, true, subject({ amountUsd: 3000 }));
    expect(inHigh).toMatchObject({ addressRequired: true, dobRequired: true });
    await seedOriginatorForTest(db, ACME, PHONE, { address: true, dob: true });
    expect(await originatorViewFor(db, true, subject({ amountUsd: 3000 }))).toEqual({
      addressRequired: true, addressOnFile: true, dobRequired: true, dobOnFile: true,
    });
  });

  it('address on file (T18 setter): addressOnFile true, nothing decrypted', async () => {
    await seedOriginatorForTest(db, ACME, PHONE, { address: true });
    const stop = captureQueries();
    const v = await originatorViewFor(db, true, subject());
    const qs = stop();
    expect(v).toEqual({ addressRequired: true, addressOnFile: true, dobRequired: false, dobOnFile: false });
    // An IS NOT NULL test only: the sealed column is never selected.
    expect(qs.some((q) => /select[\s\S]*"residential_address_enc"[\s\S]*from/i.test(q.sql) && !/is not null/i.test(q.sql))).toBe(false);
  });

  it('a Partner-API-minted transfer (originatorExempt): required false, on file true', async () => {
    const t = await row({ id: 'ov_api' });
    await createIdempotencyRepo(db).claim(ACME, 'order-1', t.id);
    expect(await originatorViewFor(db, true, subject({ transferId: t.id }))).toEqual(NO_ORIGINATOR_FIELDS);
  });

  it('a payment-link transfer is NOT exempt', async () => {
    const t = await row({ id: 'ov_link' });
    await createIdempotencyRepo(db).claim(ACME, 'paylink:pl_1', t.id);
    expect(await originatorViewFor(db, true, subject({ transferId: t.id }))).toMatchObject({ addressRequired: true, addressOnFile: false });
  });

  it('b2b: no read, not asked', async () => {
    const stop = captureQueries();
    const v = await originatorViewFor(db, true, subject({ transferType: 'b2b', transferId: 'ov_b2b' }));
    const qs = stop();
    expect(v).toEqual(NO_ORIGINATOR_FIELDS);
    expect(qs).toHaveLength(0);
  });

  it('a routed subject (routed: true), real money, nothing on file: NO_ORIGINATOR_FIELDS and no customers query', async () => {
    const stop = captureQueries();
    const v = await originatorViewFor(db, true, subject({ routed: true }));
    const qs = stop();
    expect(v).toEqual(NO_ORIGINATOR_FIELDS);
    expect(customersQueried(qs)).toBe(false);
    expect(qs).toHaveLength(0);
  });

  it('NO_ORIGINATOR_FIELDS is frozen', () => {
    expect(Object.isFrozen(NO_ORIGINATOR_FIELDS)).toBe(true);
    expect(NO_ORIGINATOR_FIELDS).toEqual({ addressRequired: false, addressOnFile: true, dobRequired: false, dobOnFile: true });
  });

  it('any read throws: required as computed, onFile false, never throws; one warn with ids and the error NAME only', async () => {
    onFileFault.throwOnRead = true;
    const v = await originatorViewFor(db, true, subject({ amountUsd: 3000, transferId: 'ov_missing' }));
    expect(v).toEqual({ addressRequired: true, addressOnFile: false, dobRequired: true, dobOnFile: false });
    const mine = warns.filter((w) => w.scope === 'pay.originator-view');
    expect(mine).toHaveLength(1);
    expect(mine[0].msg).toBe('Error');
    expect(mine[0].fields).toEqual({ partnerId: ACME, transferId: 'ov_missing' });
    expect(JSON.stringify(mine[0])).not.toContain(PHONE);
  });

  it('the exemption read throws too: required as computed, onFile false', async () => {
    const broken = new Proxy(db, {
      get(target, p, r) {
        if (p === 'select') return () => { throw new TypeError('select failed'); };
        return Reflect.get(target, p, r);
      },
    }) as Db;
    const v = await originatorViewFor(broken, true, subject({ transferId: 'ov_x' }));
    expect(v).toEqual({ addressRequired: true, addressOnFile: false, dobRequired: false, dobOnFile: false });
    expect(warns.filter((w) => w.scope === 'pay.originator-view').map((w) => w.msg)).toEqual(['TypeError']);
  });
});
