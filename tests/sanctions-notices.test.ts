import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { auditEvents, outbox, partners } from '@/db/schema';
import {
  SANCTIONS_BLOCK_AUDIT_ACTION,
  enqueueSanctionsBlockNotices,
  isDemoWatchlistBlock,
  sanctionsBlockUnrecordedKey,
  sanctionsNoticeAddress,
  type SanctionsBlockNotice,
} from '@/lib/sanctions/notices';
import { SANCTIONS_AUDIT_ACTOR, type ScreeningEvidence } from '@/lib/sanctions/evidence';
import { GLOBAL_DEFAULTS, WATCHLIST } from '@/lib/compliance-config';
import { screenTransfer } from '@/lib/compliance';
import { primeOfacSource, restoreOfacSource } from './helpers-sanctions';
import type { PartnerSupportConfig } from '@/lib/types';

// Fix pack 2 T5 (R04): every sanctions block writes a `sanctions.block` audit
// row and, unless quiet (no real money AND a sandbox row or a demo watchlist
// name), one ops.alert plus a partner email per distinct non-default partner
// (owner, rail partner) with an address. All in the caller's transaction. Ids
// only: never a name, phone or list entry id.

const NOW = () => new Date().toISOString();

function evidence(entryIds: string[], over: Partial<ScreeningEvidence> = {}): ScreeningEvidence {
  return {
    listSource: 'mock-watchlist',
    listVersion: 'static',
    listHash: 'h'.repeat(64),
    screenedAt: NOW(),
    decision: 'match',
    parties: [
      { role: 'recipient', inputHash: 'a'.repeat(64), matched: entryIds.length > 0, matchScore: 1, ...(entryIds[0] ? { matchedEntryId: entryIds[0] } : {}) },
      { role: 'sender', inputHash: 'b'.repeat(64), matched: Boolean(entryIds[1]), matchScore: entryIds[1] ? 1 : 0, ...(entryIds[1] ? { matchedEntryId: entryIds[1] } : {}) },
    ],
    ...over,
  };
}

const SDN = evidence(['sdn:1003'], { listSource: 'ofac-sdn', listVersion: '2026-11-01' });

let db: Db;
const outboxRows = () => db.select().from(outbox).orderBy(asc(outbox.id));
const auditRows = () => db.select().from(auditEvents).where(eq(auditEvents.action, SANCTIONS_BLOCK_AUDIT_ACTION)).orderBy(asc(auditEvents.id));
async function setSupport(id: string, sc: PartnerSupportConfig | Record<string, unknown>) {
  await db.update(partners).set({ supportConfig: sc as PartnerSupportConfig }).where(eq(partners.id, id));
}
const notice = (over: Partial<SanctionsBlockNotice> = {}): SanctionsBlockNotice => ({
  partnerId: 'acme',
  subjectId: 'tr_block_1',
  stage: 'mint',
  environment: 'live',
  realMoney: true,
  evidence: SDN,
  ...over,
});
const run = (n: SanctionsBlockNotice) => db.transaction((tx) => enqueueSanctionsBlockNotices(tx, n));

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme', 'Acme');
  await seedPartner(db, 'rail', 'Rail Co');
  await setSupport('acme', { alertEmail: 'ops@acme.example', complianceAlertEmail: 'compliance@acme.example' });
  await setSupport('rail', { alertEmail: 'ops@rail.example' });
});

describe('enqueueSanctionsBlockNotices', () => {
  it('real-money block -> audit + ops.alert + email.send with exact keys, to complianceAlertEmail', async () => {
    expect(await run(notice())).toEqual({ alerted: true, partnerNotified: true });
    const rows = await outboxRows();
    expect(rows.map((r) => [r.kind, r.dedupeKey])).toEqual([
      ['ops.alert', 'sanctionsblock:tr_block_1'],
      ['email.send', 'sanctionsblockmail:tr_block_1:acme'],
    ]);
    expect(rows[0].payload).toEqual({
      message: '⚠️ SmartRemit ops: sanctions block (mint) on tr_block_1, partner acme, live. Nothing paid out; evidence on the compliance page.',
    });
    expect(rows[1].payload).toEqual({
      to: ['compliance@acme.example'],
      subject: 'SmartRemit: a transfer was stopped by sanctions screening',
      text: 'Reference tr_block_1 (mint, live) was stopped by sanctions screening; nothing was paid out. Evidence is in your SmartRemit workspace. Do not share this notice with the customer.',
    });
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ partnerId: 'acme', actor: SANCTIONS_AUDIT_ACTOR, actorType: 'system', subjectId: 'tr_block_1' });
    expect(audits[0].meta).toEqual({
      stage: 'mint', environment: 'live', realMoney: true, quiet: false, alerted: true, partnerNotified: true,
      decision: 'match', listSource: 'ofac-sdn', listVersion: '2026-11-01',
    });
  });

  // Pack 2 review R1 (E2): a paid row blocked by its re-screen: the sender was charged.
  it('charged (a paid row): the alert and the email say the sender was charged and name the block and refund procedure', async () => {
    await run(notice({ stage: 'resume', charged: true }));
    const rows = await outboxRows();
    expect(rows[0].payload).toEqual({
      message:
        '⚠️ SmartRemit ops: sanctions block (resume) on tr_block_1, partner acme, live. The recipient was not paid, but the sender was charged: follow the block and refund procedure; evidence on the compliance page.',
    });
    expect((rows[1].payload as { text: string }).text).toBe(
      'Reference tr_block_1 (resume, live) was stopped by sanctions screening after the sender was charged; nothing was paid out to the recipient. Follow your block and refund procedure. Evidence is in your SmartRemit workspace. Do not share this notice with the customer.',
    );
    for (const r of rows) expect(JSON.stringify(r.payload)).not.toMatch(/Nothing paid out|; nothing was paid out\./);
  });

  it('falls back to alertEmail', async () => {
    await setSupport('acme', { alertEmail: 'ops@acme.example' });
    await run(notice());
    const mail = (await outboxRows()).find((r) => r.kind === 'email.send')!;
    expect((mail.payload as { to: string[] }).to).toEqual(['ops@acme.example']);
  });

  it('bad stored address or default partner -> no email', async () => {
    await setSupport('acme', { complianceAlertEmail: 'a@b.example\r\nBcc: x@y.example', alertEmail: 42 });
    expect(await run(notice())).toEqual({ alerted: true, partnerNotified: false });
    expect((await outboxRows()).map((r) => r.kind)).toEqual(['ops.alert']);

    await seedPartner(db, 'default', 'Default');
    await setSupport('default', { alertEmail: 'owner@smartremit.example' });
    expect(await run(notice({ partnerId: 'default', subjectId: 'tr_default' }))).toEqual({ alerted: true, partnerNotified: false });
    expect((await outboxRows()).filter((r) => r.kind === 'email.send')).toEqual([]);
    expect((await auditRows()).map((r) => (r.meta as { partnerNotified: boolean }).partnerNotified)).toEqual([false, false]);
  });

  it('demo name on simulator -> audit only (quiet)', async () => {
    expect(await run(notice({ realMoney: false, evidence: evidence(['mock:0']) }))).toEqual({ alerted: false, partnerNotified: false });
    expect(await outboxRows()).toEqual([]);
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({ quiet: true, alerted: false, partnerNotified: false, realMoney: false });
  });

  it("environment 'test' non-real-money -> quiet", async () => {
    expect(await run(notice({ realMoney: false, environment: 'test', evidence: SDN }))).toEqual({ alerted: false, partnerNotified: false });
    expect(await outboxRows()).toEqual([]);
    expect((await auditRows())[0].meta).toMatchObject({ quiet: true, environment: 'test' });
  });

  it('demo name on an http rail -> alerted', async () => {
    expect(await run(notice({ realMoney: true, evidence: evidence(['mock:1']) }))).toEqual({ alerted: true, partnerNotified: true });
    expect((await outboxRows()).map((r) => r.kind)).toEqual(['ops.alert', 'email.send']);
  });

  it('extra:3 on simulator -> alerted (not a demo entry)', async () => {
    expect(await run(notice({ realMoney: false, evidence: evidence(['extra:3'], { listSource: 'ofac-sdn' }) }))).toEqual({ alerted: true, partnerNotified: true });
    expect((await outboxRows()).map((r) => r.kind)).toEqual(['ops.alert', 'email.send']);
  });

  it('routed default-owner block emails the rail partner, not the default owner', async () => {
    await seedPartner(db, 'default', 'Default');
    await setSupport('default', { alertEmail: 'owner@smartremit.example' });
    expect(await run(notice({ partnerId: 'default', railPartnerId: 'rail', stage: 'card' }))).toEqual({ alerted: true, partnerNotified: true });
    const mails = (await outboxRows()).filter((r) => r.kind === 'email.send');
    expect(mails.map((r) => [r.dedupeKey, (r.payload as { to: string[] }).to])).toEqual([
      ['sanctionsblockmail:tr_block_1:rail', ['ops@rail.example']],
    ]);
  });

  it('owner and rail partner both non-default -> two emails, distinct keys', async () => {
    await run(notice({ railPartnerId: 'rail' }));
    const mails = (await outboxRows()).filter((r) => r.kind === 'email.send');
    expect(mails.map((r) => r.dedupeKey)).toEqual(['sanctionsblockmail:tr_block_1:acme', 'sanctionsblockmail:tr_block_1:rail']);
    // The same partner as owner and rail is emailed once.
    await run(notice({ subjectId: 'tr_block_2', railPartnerId: 'acme' }));
    expect((await outboxRows()).filter((r) => r.dedupeKey?.startsWith('sanctionsblockmail:tr_block_2:'))).toHaveLength(1);
  });

  it('no name, phone or entry id in any payload or audit meta', async () => {
    const ev = evidence(['sdn:1003', 'mock:2'], { listSource: 'ofac-sdn' });
    await run(notice({ railPartnerId: 'rail', evidence: ev }));
    const blob = JSON.stringify({ o: (await outboxRows()).map((r) => r.payload), a: (await auditRows()).map((r) => r.meta) });
    for (const banned of ['sdn:1003', 'mock:2', 'a'.repeat(64), 'b'.repeat(64), ...WATCHLIST]) expect(blob).not.toContain(banned);
    expect(blob).not.toMatch(/\d{10,}/);
  });

  it('replay dedupes (one alert, one email)', async () => {
    await run(notice());
    await run(notice());
    const rows = await outboxRows();
    expect(rows.filter((r) => r.kind === 'ops.alert')).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'email.send')).toHaveLength(1);
  });

  it("rolls back with the caller's transaction", async () => {
    await expect(
      db.transaction(async (tx) => {
        await enqueueSanctionsBlockNotices(tx, notice());
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await outboxRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });
});

describe('isDemoWatchlistBlock / sanctionsNoticeAddress / sanctionsBlockUnrecordedKey', () => {
  it('demo only when every matched entry is a WATCHLIST index (mock:<i> or extra:<i>)', () => {
    expect(isDemoWatchlistBlock(undefined)).toBe(false);
    expect(isDemoWatchlistBlock(evidence([]))).toBe(false);
    expect(isDemoWatchlistBlock(evidence(['mock:0']))).toBe(true);
    expect(isDemoWatchlistBlock(evidence(['mock:0', `extra:${WATCHLIST.length - 1}`]))).toBe(true);
    expect(isDemoWatchlistBlock(evidence([`mock:${WATCHLIST.length}`]))).toBe(false);
    expect(isDemoWatchlistBlock(evidence(['mock:0', 'sdn:1003']))).toBe(false);
    expect(isDemoWatchlistBlock(evidence(['mock:x']))).toBe(false);
    expect(isDemoWatchlistBlock(evidence(['mock:-1']))).toBe(false);
    const noId = evidence([]);
    noId.parties[0] = { ...noId.parties[0], matched: true };
    expect(isDemoWatchlistBlock(noId)).toBe(false);
  });

  it('address: compliance ?? alert, each re-checked; junk and non-strings are null', () => {
    expect(sanctionsNoticeAddress(undefined)).toBeNull();
    expect(sanctionsNoticeAddress({ complianceAlertEmail: ' c@x.example ', alertEmail: 'a@x.example' })).toBe('c@x.example');
    expect(sanctionsNoticeAddress({ complianceAlertEmail: 'junk', alertEmail: 'a@x.example' })).toBe('a@x.example');
    expect(sanctionsNoticeAddress({ alertEmail: 'a@x.example, b@x.example' })).toBeNull();
    expect(sanctionsNoticeAddress({ alertEmail: 7 } as unknown as PartnerSupportConfig)).toBeNull();
  });

  it('the unrecorded key', () => {
    expect(sanctionsBlockUnrecordedKey('acme', 123)).toBe('sanctions-block-unrecorded:acme:123');
  });
});

describe('isDemoWatchlistBlock relies on WATCHLIST first (pin)', () => {
  const ORIGINAL_LIST = process.env.SANCTIONS_LIST;
  afterEach(() => restoreOfacSource(ORIGINAL_LIST));
  const rules = { ...GLOBAL_DEFAULTS, watchlistExtra: ['Corridor Extra Person'] };

  it('the base list is WATCHLIST itself', () => {
    expect(GLOBAL_DEFAULTS.baseWatchlist).toBe(WATCHLIST);
  });

  it('mock list: a WATCHLIST name is demo, a corridor extra is not', async () => {
    delete process.env.SANCTIONS_LIST;
    const demo = await screenTransfer({ amountUsd: 10, recipientName: WATCHLIST[0], transfersToday: 0, rules });
    expect(demo.status).toBe('blocked');
    expect(isDemoWatchlistBlock(demo.evidence)).toBe(true);
    const extra = await screenTransfer({ amountUsd: 10, recipientName: 'Corridor Extra Person', transfersToday: 0, rules });
    expect(extra.status).toBe('blocked');
    expect(isDemoWatchlistBlock(extra.evidence)).toBe(false);
  });

  it('ofac list: a WATCHLIST name (extra:<i>) is demo, a corridor extra and an SDN name are not', async () => {
    primeOfacSource({ checkedAgoMs: 3_600_000 });
    const demo = await screenTransfer({ amountUsd: 10, recipientName: WATCHLIST[1], transfersToday: 0, rules });
    expect(demo.status).toBe('blocked');
    expect(isDemoWatchlistBlock(demo.evidence)).toBe(true);
    const extra = await screenTransfer({ amountUsd: 10, recipientName: 'Corridor Extra Person', transfersToday: 0, rules });
    expect(isDemoWatchlistBlock(extra.evidence)).toBe(false);
    const sdn = await screenTransfer({ amountUsd: 10, recipientName: 'Testa Fixturelli', transfersToday: 0, rules });
    expect(sdn.status).toBe('blocked');
    expect(isDemoWatchlistBlock(sdn.evidence)).toBe(false);
  });
});
