import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { railMessages } from '@/db/schema';
import {
  RAIL_IN,
  RAIL_OUT,
  createRailMessageRepo,
  inboundRailMessageId,
  railBodySha256,
} from '@/db/repos/rail-message-repo';
import { ctx } from '@/lib/crypto-context';
import { decryptField, EnvKeyProvider } from '@/lib/field-crypto';

// Fix pack 5 (P3, P4): the sealed, append-only rail record (table 0039). The
// repo seals the exact body under ctx.railMessage(id, direction, kind), stores
// its sha256 and the signature header, and THROWS on any failure (the worker
// wraps it as RailRecordError, T9). Its one reader returns metadata only.

let db: Db;
const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BODY = '{"transfer_id":"t1","amount":{"destination":16600,"destination_currency":"INR"},"name":"Ravi Kumar"}';
const HEADER = 't=1700000000,v2=abcdef';

type Row = Record<string, unknown>;
const rows = async (): Promise<Row[]> =>
  ((await db.execute(sql`SELECT * FROM rail_messages ORDER BY created_at, id`)) as unknown as { rows: Row[] }).rows;

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
});

describe('railBodySha256', () => {
  it('railBodySha256 is the lowercase hex sha256 of the UTF-8 bytes', () => {
    expect(railBodySha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const s = 'Zahlung für Priyā ₹ 😀';
    expect(railBodySha256(s)).toBe(createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex'));
    expect(railBodySha256(s)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('inboundRailMessageId', () => {
  it('inboundRailMessageId is stable, v5-shaped and changes with every part', () => {
    const base = { railPartnerId: 'pa', bodySha256: railBodySha256(BODY), signatureHeader: HEADER };
    const a = inboundRailMessageId(base);
    expect(a).toMatch(UUID_V5);
    expect(inboundRailMessageId({ ...base })).toBe(a);
    expect(inboundRailMessageId({ ...base, railPartnerId: 'pb' })).not.toBe(a);
    expect(inboundRailMessageId({ ...base, bodySha256: railBodySha256('other') })).not.toBe(a);
    expect(inboundRailMessageId({ ...base, signatureHeader: 't=1,v2=00' })).not.toBe(a);
    const unresolved = inboundRailMessageId({ ...base, railPartnerId: null });
    expect(unresolved).toMatch(UUID_V5);
    expect(unresolved).not.toBe(a);
    expect(inboundRailMessageId({ ...base, signatureHeader: null })).toMatch(UUID_V5);
  });
});

describe('createRailMessageRepo.append', () => {
  it('append seals the exact body and stores hash and header', async () => {
    const repo = createRailMessageRepo(db, provider);
    const r = await repo.append({
      partnerId: 'pa',
      railPartnerId: 'pb',
      transferId: 't1',
      direction: RAIL_OUT,
      kind: 'settle',
      body: BODY,
      signatureHeader: HEADER,
    });
    expect(r.inserted).toBe(true);
    expect(r.bodySha256).toBe(railBodySha256(BODY));
    const [raw] = await rows();
    expect(raw.id).toBe(r.id);
    expect(String(raw.body_enc)).toMatch(/^v2\.k0\./);
    expect(String(raw.body_enc)).not.toContain('Ravi');
    expect(String(raw.body_enc)).not.toContain('transfer_id');
    expect(decryptField(String(raw.body_enc), provider, ctx.railMessage(r.id, 1, 'settle'))).toBe(BODY);
    expect(raw.body_sha256).toBe(railBodySha256(BODY));
    expect(raw.signature_header).toBe(HEADER);
    expect(raw.partner_id).toBe('pa');
    expect(raw.rail_partner_id).toBe('pb');
    expect(raw.transfer_id).toBe('t1');
    expect(Number(raw.direction)).toBe(1);
    expect(raw.kind).toBe('settle');
    expect(r).toEqual({ id: r.id, bodySha256: railBodySha256(BODY), inserted: true });
  });

  it('the blob opens only in its own row context', async () => {
    const repo = createRailMessageRepo(db, provider);
    const { id } = await repo.append({
      partnerId: 'pa', railPartnerId: 'pa', transferId: 't1', direction: RAIL_OUT, kind: 'settle', body: BODY, signatureHeader: HEADER,
    });
    const [raw] = await rows();
    const blob = String(raw.body_enc);
    expect(() => decryptField(blob, provider, ctx.railMessage(id, 2, 'settle'))).toThrow();
    expect(() => decryptField(blob, provider, ctx.railMessage(id, 1, 'reverse'))).toThrow();
    expect(() => decryptField(blob, provider, ctx.railMessage('0b7c2f7e-1a2b-4c3d-8e9f-001122334455', 1, 'settle'))).toThrow();
  });

  it('outbound: one row per call, a fresh uuid each time', async () => {
    const repo = createRailMessageRepo(db, provider);
    const i = { partnerId: 'pa', railPartnerId: 'pa', transferId: 't1', direction: RAIL_OUT, kind: 'settle' as const, body: BODY, signatureHeader: HEADER };
    const a = await repo.append(i);
    const b = await repo.append(i);
    expect(a.inserted && b.inserted).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(await rows()).toHaveLength(2);
  });

  it('inbound: a replay is a no-op', async () => {
    const repo = createRailMessageRepo(db, provider);
    const i = { partnerId: 'pa', railPartnerId: 'pa', transferId: 't1', direction: RAIL_IN, kind: 'callback' as const, body: BODY, signatureHeader: HEADER };
    const a = await repo.append(i);
    const b = await repo.append(i);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.id).toBe(a.id);
    expect(a.id).toBe(inboundRailMessageId({ railPartnerId: 'pa', bodySha256: railBodySha256(BODY), signatureHeader: HEADER }));
    expect(await rows()).toHaveLength(1);
    const c = await repo.append({ ...i, signatureHeader: 't=1700000001,v2=fedcba' });
    expect(c.inserted).toBe(true);
    expect(c.id).not.toBe(a.id);
    expect(await rows()).toHaveLength(2);
  });

  it('an unresolved callback stores partner_id and rail_partner_id NULL and keeps the claimed transfer id', async () => {
    const repo = createRailMessageRepo(db, provider);
    const r = await repo.append({
      partnerId: null, railPartnerId: null, transferId: 'claimed_ref', direction: RAIL_IN, kind: 'callback', body: BODY, signatureHeader: null,
    });
    expect(r.inserted).toBe(true);
    const [raw] = await rows();
    expect(raw.partner_id).toBeNull();
    expect(raw.rail_partner_id).toBeNull();
    expect(raw.transfer_id).toBe('claimed_ref');
    expect(raw.signature_header).toBeNull();
    expect(decryptField(String(raw.body_enc), provider, ctx.railMessage(r.id, 2, 'callback'))).toBe(BODY);
  });

  it('append THROWS and writes nothing: unknown partner (FK)', async () => {
    const repo = createRailMessageRepo(db, provider);
    await expect(
      repo.append({ partnerId: 'nope', railPartnerId: 'pa', transferId: 't1', direction: RAIL_OUT, kind: 'settle', body: BODY, signatureHeader: HEADER }),
    ).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });

  it('append THROWS and writes nothing: the insert itself throws', async () => {
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (table: unknown) => {
            if (table === railMessages) throw new Error('rail record down');
            return target.insert(table as never);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const repo = createRailMessageRepo(failing, provider);
    await expect(
      repo.append({ partnerId: 'pa', railPartnerId: 'pa', transferId: 't1', direction: RAIL_OUT, kind: 'settle', body: BODY, signatureHeader: HEADER }),
    ).rejects.toThrow('rail record down');
    expect(await rows()).toHaveLength(0);
  });
});

describe('createRailMessageRepo.listForTransfer', () => {
  it('listForTransfer is tenant-scoped and carries no body', async () => {
    const repo = createRailMessageRepo(db, provider);
    const base = { railPartnerId: 'pa', direction: RAIL_OUT, kind: 'settle' as const, body: BODY, signatureHeader: HEADER };
    const first = await repo.append({ ...base, partnerId: 'pa', transferId: 't1' });
    const second = await repo.append({ ...base, partnerId: 'pa', transferId: 't1', direction: RAIL_IN, kind: 'callback' });
    await repo.append({ ...base, partnerId: 'pb', railPartnerId: 'pb', transferId: 't1' });
    await repo.append({ ...base, partnerId: null, railPartnerId: null, transferId: 't1', direction: RAIL_IN, kind: 'callback', signatureHeader: 'x' });
    await repo.append({ ...base, partnerId: 'pa', transferId: 't2' });

    const list = await repo.listForTransfer('pa', 't1');
    expect(list).toHaveLength(2);
    expect(new Set(list.map((m) => m.id))).toEqual(new Set([first.id, second.id]));
    // oldest first (ties broken by id)
    const sorted = [...list].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
    expect(list).toEqual(sorted);
    for (const m of list) {
      expect(Object.keys(m).sort()).toEqual(['bodySha256', 'createdAt', 'direction', 'id', 'kind', 'routed']);
      expect(m.bodySha256).toBe(railBodySha256(BODY));
      expect(typeof m.createdAt).toBe('string');
      expect(new Date(m.createdAt).toISOString()).toBe(m.createdAt);
    }
    const byId = new Map(list.map((m) => [m.id, m]));
    expect(byId.get(first.id)).toMatchObject({ direction: 1, kind: 'settle' });
    expect(byId.get(second.id)).toMatchObject({ direction: 2, kind: 'callback' });
    const json = JSON.stringify(list);
    expect(json).not.toContain('Ravi');
    expect(json).not.toContain('transfer_id');
    expect(json).not.toContain('v2.');
    expect(json).not.toContain(HEADER);
    expect(await repo.listForTransfer('pb', 't2')).toEqual([]);
  });

  it("a routed row's reader output names no other partner id", async () => {
    const repo = createRailMessageRepo(db, provider);
    await repo.append({ partnerId: 'pa', railPartnerId: 'pb', transferId: 't1', direction: RAIL_OUT, kind: 'settle', body: BODY, signatureHeader: HEADER });
    await repo.append({ partnerId: 'pa', railPartnerId: 'pa', transferId: 't9', direction: RAIL_OUT, kind: 'settle', body: BODY, signatureHeader: HEADER });
    const routed = await repo.listForTransfer('pa', 't1');
    expect(routed).toHaveLength(1);
    expect(routed[0].routed).toBe(true);
    expect(JSON.stringify(routed)).not.toContain('pb');
    const own = await repo.listForTransfer('pa', 't9');
    expect(own).toHaveLength(1);
    expect(own[0].routed).toBe(false);
  });
});

// Review round 1 RC2: the refund path's one lookup. Owner-scoped, this rail
// partner only, outbound 'settle' only, the newest time, nothing else.
describe('createRailMessageRepo.lastSettleOutAt (review round 1 RC2)', () => {
  it('the newest outbound settle for (owner, transfer, rail partner); null when none; other kinds, directions, rails and owners do not count', async () => {
    const repo = createRailMessageRepo(db, provider);
    expect(await repo.lastSettleOutAt('pa', 't1', 'pa')).toBeNull();
    const base = { partnerId: 'pa', railPartnerId: 'pa', transferId: 't1', direction: RAIL_OUT, kind: 'settle' as const, body: BODY, signatureHeader: HEADER };
    await repo.append(base);
    await repo.append({ ...base, kind: 'reverse' });
    await repo.append({ ...base, direction: RAIL_IN, kind: 'callback' });
    await repo.append({ ...base, railPartnerId: 'pb' });
    await repo.append({ ...base, partnerId: 'pb' });
    const rows = (await db.execute(sql`SELECT created_at FROM rail_messages WHERE partner_id = 'pa' AND rail_partner_id = 'pa' AND kind = 'settle' AND direction = 1`)) as unknown as { rows: Array<{ created_at: string | Date }> };
    const expected = Math.max(...rows.rows.map((r) => new Date(r.created_at).getTime()));
    const got = await repo.lastSettleOutAt('pa', 't1', 'pa');
    expect(got).toBeInstanceOf(Date);
    expect(got!.getTime()).toBe(expected);
    expect(await repo.lastSettleOutAt('pa', 't2', 'pa')).toBeNull();
    expect(await repo.lastSettleOutAt('pb', 't1', 'pb')).toBeNull(); // owner pb has a settle only to rail pa
    expect(await repo.lastSettleOutAt('pa', 't1', 'pb')).not.toBeNull();
  });
});
