import { describe, it, expect, afterEach } from 'vitest';
import { freshDb, seedLedgerSpend } from './helpers-db';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { rescreenBeforePay } from '@/lib/pay-rescreen';
import { GLOBAL_DEFAULTS } from '@/lib/compliance-config';
import { NEWLY_LISTED_PERSON, listSetList, primeListSet, primeStaleOfacSource, restoreOfacSource } from './helpers-sanctions';
import { PostgresSanctionsListSource } from '@/lib/sanctions/pg-list-source';
import { setListSourceForTests } from '@/lib/providers/sanctions-provider';
import type { ActiveSanctionsVersion } from '@/db/repos/sanctions-list-repo';
import type { SanctionsList } from '@/lib/sanctions/list-source';

// Program-Fix 14 PR C (review r1 MEDIUM): the OFAC source serves its cached
// list until warm() re-checks the active version. Every screen OUTSIDE a
// transaction must warm first, or a long-lived instance screens a stale list
// forever. The mint warms before its lock (transfer-create.test.ts); the pay
// re-screen is covered here, the two tool screens in tools.test.ts.
describe('rescreenBeforePay warms the OFAC list before screening', () => {
  const original = process.env.SANCTIONS_LIST;
  afterEach(() => restoreOfacSource(original));

  it('a name added in the newly activated version blocks the payment', async () => {
    const db = await freshDb();
    const id = await seedLedgerSpend(db, { partnerId: 'default', phone: '15550190001', amountUsd: 50, status: 'awaiting_payment' });
    const t = (await createTransferRepo(db).getTransfer(id))!;
    await primeStaleOfacSource();
    const out = await rescreenBeforePay(db, t, { senderName: 'Clean Sender', recipientName: NEWLY_LISTED_PERSON }, GLOBAL_DEFAULTS);
    expect(out.kind).toBe('blocked');
  });
});

// Fix pack 5 T28 (R08, P25): under SANCTIONS_LIST=lists the warm reaches EVERY
// source, so a stale cache on any one list is refreshed before the screen.
describe('rescreenBeforePay warms every list under "lists"', () => {
  const original = process.env.SANCTIONS_LIST;
  afterEach(() => restoreOfacSource(original));

  it('a name newly listed on the un-sc source (stale-cached) blocks the payment', async () => {
    const db = await freshDb();
    const id = await seedLedgerSpend(db, { partnerId: 'default', phone: '15550190002', amountUsd: 50, status: 'awaiting_payment' });
    const t = (await createTransferRepo(db).getTransfer(id))!;
    primeListSet({});
    const v1 = listSetList('un-sc');
    const v2: SanctionsList = {
      ...v1,
      version: '2026-10-02',
      hash: 'd'.repeat(64),
      entries: [...v1.entries, { id: 'unsc:2', names: [NEWLY_LISTED_PERSON], type: 'Individual', programs: ['TEST'] }],
    };
    const V1: ActiveSanctionsVersion = { id: 11, source: 'un-sc', version: v1.version, hash: v1.hash, entryCount: v1.entries.length };
    const V2: ActiveSanctionsVersion = { id: 12, source: 'un-sc', version: v2.version, hash: v2.hash, entryCount: v2.entries.length };
    const state = { active: V1 };
    const stale = new PostgresSanctionsListSource(
      () => ({ activeVersion: async () => state.active, loadList: async (v) => (v.id === 11 ? v1 : v2) }),
      { source: 'un-sc', ttlMs: 0 },
    );
    await stale.load(); // v1 cached
    state.active = V2; // v2 activated after the TTL
    setListSourceForTests('un-sc', stale);
    const out = await rescreenBeforePay(db, t, { senderName: 'Clean Sender', recipientName: NEWLY_LISTED_PERSON }, GLOBAL_DEFAULTS);
    expect(out.kind).toBe('blocked');
  });
});
