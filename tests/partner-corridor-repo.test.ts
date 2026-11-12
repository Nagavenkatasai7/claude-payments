import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPartnerCorridorRepo, CorridorWriteRefused } from '@/db/repos/partner-corridor-repo';
import { corridorActive, corridorRowHash, type CorridorInput } from '@/lib/corridor-register';
import type { Db } from '@/db/client';
import { captureQueries, freshDb, seedPartner } from './helpers-db';

// Fix pack 8 T9 (P24): the destination register repo. Tenant-scoped; the
// writers refuse the default tenant, lock the row and clear the attestation on
// every save; attest re-checks the pc1 hash under the lock. Dates relative.

const PA = 'pa';
const PB = 'pb';
const DAY = 86_400_000;
const dayOffset = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

function input(o: Partial<CorridorInput> = {}): CorridorInput {
  return {
    destinationCountry: 'IN',
    status: 'active',
    rulePack: null,
    purposeCodeMap: { family_support: 'P1301' },
    attestationRef: 'att-ref-1',
    attestationSha256: null,
    recipientNotices: false,
    travelDobFromUsd: 900,
    travelFullFromUsd: 2500,
    reattestDue: dayOffset(180),
    ...o,
  };
}

async function count(db: Db): Promise<number> {
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM partner_corridors`)) as unknown as { rows: Array<{ n: number }> };
  return r.rows[0].n;
}

async function recordAndAttest(db: Db, partnerId: string, cc: CorridorInput['destinationCountry'], o: Partial<CorridorInput> = {}) {
  const repo = createPartnerCorridorRepo(db);
  const { row } = await repo.upsertRecorded(partnerId, cc, input({ destinationCountry: cc, ...o }), 'test-admin');
  expect(await repo.attest(partnerId, cc, corridorRowHash(row), 'test-partner-admin')).toBe('attested');
}

describe('partner corridor repo (P24)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, PA);
    await seedPartner(db, PB);
  });

  it('upsertRecorded inserts and returns previous null; get maps numbers, dates and the map', async () => {
    const repo = createPartnerCorridorRepo(db);
    const { previous, row } = await repo.upsertRecorded(PA, 'IN', input(), 'test-admin');
    expect(previous).toBeNull();
    const got = await repo.get(PA, 'IN');
    expect(got).toEqual(row);
    expect(got!.travelDobFromUsd).toBe(900);
    expect(got!.travelFullFromUsd).toBe(2500);
    expect(got!.reattestDue).toBe(dayOffset(180));
    expect(got!.purposeCodeMap).toEqual({ family_support: 'P1301' });
    expect(got!.recordedBy).toBe('test-admin');
    expect(Number.isNaN(Date.parse(got!.recordedAt))).toBe(false);
    expect(got!.recordedAt).toBe(new Date(got!.recordedAt).toISOString());
    expect(got!.attestedHash).toBeNull();
    expect(await repo.get(PB, 'IN')).toBeNull();
    expect(await repo.listForPartner(PA)).toEqual([row]);
  });

  it('a second save returns the previous row and CLEARS the attestation', async () => {
    const repo = createPartnerCorridorRepo(db);
    await recordAndAttest(db, PA, 'IN');
    const attested = await repo.get(PA, 'IN');
    expect(corridorActive(attested, new Date())).toBe(true);
    const { previous, row } = await repo.upsertRecorded(PA, 'IN', input({ recipientNotices: true }), 'test-admin-2');
    expect(previous).toEqual(attested);
    expect(row.attestedBy).toBeNull();
    expect(row.attestedAt).toBeNull();
    expect(row.attestedHash).toBeNull();
    expect(row.recipientNotices).toBe(true);
    expect(row.recordedBy).toBe('test-admin-2');
    expect(corridorActive(await repo.get(PA, 'IN'), new Date())).toBe(false);
  });

  it('refuses the default tenant and a body country that differs from the route', async () => {
    const repo = createPartnerCorridorRepo(db);
    const codeOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'resolved';
      } catch (e) {
        expect(e).toBeInstanceOf(CorridorWriteRefused);
        return (e as CorridorWriteRefused).code;
      }
    };
    expect(await codeOf(repo.upsertRecorded('default', 'IN', input(), 'a'))).toBe('default_tenant');
    expect(await codeOf(repo.setStatus('default', 'IN', 'suspended', 'a'))).toBe('default_tenant');
    expect(await codeOf(repo.attest('default', 'IN', 'pc1:x', 'a'))).toBe('default_tenant');
    expect(await codeOf(repo.upsertRecorded(PA, 'GB', input(), 'a'))).toBe('route_mismatch');
    expect(await count(db)).toBe(0);
  });

  it("attest: missing -> 'missing'; a stale hash -> 'changed'; the current hash -> 'attested'", async () => {
    const repo = createPartnerCorridorRepo(db);
    expect(await repo.attest(PA, 'IN', 'pc1:none', 'p-admin')).toBe('missing');
    const { row } = await repo.upsertRecorded(PA, 'IN', input(), 'test-admin');
    const stale = corridorRowHash({ ...row, recipientNotices: true });
    expect(await repo.attest(PA, 'IN', stale, 'p-admin')).toBe('changed');
    expect((await repo.get(PA, 'IN'))!.attestedHash).toBeNull();
    expect(await repo.attest(PB, 'IN', corridorRowHash(row), 'p-admin')).toBe('missing');
    expect(await repo.attest(PA, 'IN', corridorRowHash(row), 'p-admin')).toBe('attested');
    const got = await repo.get(PA, 'IN');
    expect(got!.attestedBy).toBe('p-admin');
    expect(got!.attestedHash).toBe(corridorRowHash(row));
    expect(corridorActive(got, new Date())).toBe(true);
    // idempotent re-stamp
    expect(await repo.attest(PA, 'IN', corridorRowHash(row), 'p-admin-2')).toBe('attested');
    expect((await repo.get(PA, 'IN'))!.attestedBy).toBe('p-admin-2');
  });

  it('setStatus suspends, clears the attestation and returns previous/row; missing -> null', async () => {
    const repo = createPartnerCorridorRepo(db);
    expect(await repo.setStatus(PA, 'IN', 'suspended', 'test-admin')).toBeNull();
    await recordAndAttest(db, PA, 'IN');
    const before = await repo.get(PA, 'IN');
    const r = await repo.setStatus(PA, 'IN', 'suspended', 'test-admin-3');
    expect(r).not.toBeNull();
    expect(r!.previous).toEqual(before);
    expect(r!.row.status).toBe('suspended');
    expect(r!.row.recordedBy).toBe('test-admin-3');
    expect(r!.row.attestedHash).toBeNull();
    expect(r!.row.attestedBy).toBeNull();
    expect(r!.row.attestedAt).toBeNull();
    expect(await repo.get(PA, 'IN')).toEqual(r!.row);
    expect(await repo.setStatus(PB, 'IN', 'suspended', 'test-admin')).toBeNull();
  });

  it('countActive / activeDestinations count only attested, active, not past-due rows of that partner', async () => {
    const repo = createPartnerCorridorRepo(db);
    await recordAndAttest(db, PA, 'IN');
    await recordAndAttest(db, PA, 'GB', { status: 'suspended' });
    await recordAndAttest(db, PA, 'AE');
    await db.execute(sql`UPDATE partner_corridors SET reattest_due = ${dayOffset(-1)}::date WHERE partner_id = ${PA} AND destination_country = 'AE'`);
    await recordAndAttest(db, PB, 'MX');
    const now = new Date();
    expect(await repo.countActive(PA, now)).toBe(1);
    expect(await repo.activeDestinations(PA, now)).toEqual(['IN']);
    expect(await repo.activeDestinations(PB, now)).toEqual(['MX']);
    expect((await repo.listForPartner(PA)).map((r) => r.destinationCountry)).toEqual(['AE', 'GB', 'IN']);
  });

  it('listReattestDue returns active rows inside the window across partners, ids/codes/date only', async () => {
    const repo = createPartnerCorridorRepo(db);
    await recordAndAttest(db, PA, 'IN', { reattestDue: dayOffset(10) });
    await recordAndAttest(db, PA, 'GB', { reattestDue: dayOffset(5), status: 'suspended' });
    await recordAndAttest(db, PA, 'AE', { reattestDue: dayOffset(60) });
    await recordAndAttest(db, PB, 'MX', { reattestDue: dayOffset(14) });
    const due = await repo.listReattestDue(new Date(), 14);
    const sorted = [...due].sort((a, b) => a.partnerId.localeCompare(b.partnerId));
    expect(sorted).toEqual([
      { partnerId: PA, destinationCountry: 'IN', reattestDue: dayOffset(10) },
      { partnerId: PB, destinationCountry: 'MX', reattestDue: dayOffset(14) },
    ]);
  });

  it('an unknown stored status or pack maps as closed and logs ids only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const repo = createPartnerCorridorRepo(db);
      await recordAndAttest(db, PA, 'IN');
      await recordAndAttest(db, PA, 'GB');
      await db.execute(sql`UPDATE partner_corridors SET status = 'paused' WHERE partner_id = ${PA} AND destination_country = 'IN'`);
      await db.execute(sql`UPDATE partner_corridors SET rule_pack = 'IN-MTSS-v9' WHERE partner_id = ${PA} AND destination_country = 'GB'`);
      const inRow = await repo.get(PA, 'IN');
      const gbRow = await repo.get(PA, 'GB');
      expect(inRow!.status).toBe('closed');
      expect(gbRow!.status).toBe('closed');
      expect(gbRow!.rulePack).toBeNull();
      expect(corridorActive(inRow, new Date())).toBe(false);
      expect(await repo.countActive(PA, new Date())).toBe(0);
      const logged = warn.mock.calls.map((c) => c.map((x) => String(x)).join(' ')).join('\n');
      expect(logged).toContain('partner-corridor.unknown_value');
      expect(logged).not.toContain('att-ref-1');
      expect(logged).not.toContain('pc1:');
      expect(logged).not.toContain('paused');
      expect(logged).not.toContain('IN-MTSS-v9');
    } finally {
      warn.mockRestore();
    }
  });

  it('every partner-facing statement has partner_id in the WHERE', async () => {
    const repo = createPartnerCorridorRepo(db);
    const stop = captureQueries();
    const { row } = await repo.upsertRecorded(PA, 'IN', input(), 'test-admin');
    await repo.attest(PA, 'IN', corridorRowHash(row), 'p-admin');
    await repo.get(PA, 'IN');
    await repo.listForPartner(PA);
    await repo.countActive(PA, new Date());
    await repo.activeDestinations(PA, new Date());
    await repo.setStatus(PA, 'IN', 'suspended', 'test-admin');
    const qs = stop();
    expect(qs.length).toBeGreaterThanOrEqual(9);
    for (const q of qs) expect(q.sql).toContain('"partner_id" = ');
  });

  it('the writers lock the row', async () => {
    const repo = createPartnerCorridorRepo(db);
    const firstOf = async (fn: () => Promise<unknown>) => {
      const stop = captureQueries();
      await fn();
      const qs = stop();
      return qs[0].sql.toLowerCase();
    };
    const up = await firstOf(() => repo.upsertRecorded(PA, 'IN', input(), 'test-admin'));
    expect(up.startsWith('select')).toBe(true);
    expect(up).toContain('for update');
    const row = (await repo.get(PA, 'IN'))!;
    const at = await firstOf(() => repo.attest(PA, 'IN', corridorRowHash(row), 'p-admin'));
    expect(at.startsWith('select')).toBe(true);
    expect(at).toContain('for update');
    const st = await firstOf(() => repo.setStatus(PA, 'IN', 'suspended', 'test-admin'));
    expect(st.startsWith('select')).toBe(true);
    expect(st).toContain('for update');
  });

  it("runs inside a caller's transaction", async () => {
    await expect(
      db.transaction(async (tx) => {
        await createPartnerCorridorRepo(tx).upsertRecorded(PA, 'IN', input(), 'test-admin');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await count(db)).toBe(0);
  });

  it('a saved row read back keeps the golden pc1 digest (early review FD1)', async () => {
    // The same literal row as tests/corridor-register.test.ts's golden test. Numeric
    // and date columns come back from Postgres as strings: the mapping must not
    // change the hash. A change of this value means every stored attestation stops
    // matching: bump the version prefix (lm1 / pc1) and re-attest.
    const GOLDEN_PC1 = 'pc1:0454ebdd5fdeb9743e305e81b3a3b7ab6d17681bce5517c7ee915c47e8be2e95';
    const repo = createPartnerCorridorRepo(db);
    const golden: CorridorInput = {
      destinationCountry: 'IN',
      status: 'active',
      rulePack: 'IN-MTSS-v1',
      purposeCodeMap: { family_support: 'P1301', education: 'P1302' },
      attestationRef: 'att/2026.pdf',
      attestationSha256: 'a'.repeat(64),
      recipientNotices: true,
      travelDobFromUsd: 900.5,
      travelFullFromUsd: 2500,
      reattestDue: '2027-06-30',
    };
    const { row } = await repo.upsertRecorded(PA, 'IN', golden, 'golden-admin');
    expect(corridorRowHash(row)).toBe(GOLDEN_PC1);
    const readBack = await repo.get(PA, 'IN');
    expect(corridorRowHash(readBack!)).toBe(GOLDEN_PC1);
    expect((await repo.listForPartner(PA)).map(corridorRowHash)).toEqual([GOLDEN_PC1]);
  });
});
