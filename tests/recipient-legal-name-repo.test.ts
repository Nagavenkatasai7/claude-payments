import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { recipients, recipientTombstones } from '@/db/schema';
import { createRecipientRepo, type RecipientRepo } from '@/db/repos/aux-repos';
import { EnvKeyProvider, decryptField } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import type { Recipient } from '@/lib/types';
import { captureQueries, freshDb, seedPartner } from './helpers-db';

// Fix pack 4 (C3): the recipient's account-holder name on the saved-recipient row.
// Sealed under recipients|legal_name_enc, read only through getRecipientLegalName,
// filled only by fillRecipientLegalName, and bound to the account it was typed for:
// an upsert or edit WITHOUT a name keeps it only while the payout method and last 4
// stay the same and the row is not being un-deleted. The generic Recipient never
// carries it.

const provider = new EnvKeyProvider(Buffer.alloc(32, 7));
const SENDER = '14155550101';
const RP = '919876543210';
const NAME = 'Anita Legal';

const at = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const rec = (over: Partial<Recipient> = {}): Recipient => ({
  name: 'Mom',
  recipientPhone: RP,
  payoutMethod: 'bank',
  payoutDestination: 'HDFC0000001 000011112222',
  lastUsedAt: at(),
  ...over,
});

let db: Db;
let repo: RecipientRepo;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa', 'Partner A');
  await seedPartner(db, 'pb', 'Partner B');
  repo = createRecipientRepo(db, provider);
});

async function rawLegal(partnerId = 'pa', senderPhone = SENDER, recipientPhone = RP): Promise<string | null | undefined> {
  const rows = await db
    .select({ v: recipients.legalNameEnc })
    .from(recipients)
    .where(
      and(
        eq(recipients.partnerId, partnerId),
        eq(recipients.senderPhone, senderPhone),
        eq(recipients.recipientPhone, recipientPhone),
      ),
    );
  return rows[0]?.v;
}

async function tombstoneCount(): Promise<number> {
  return (await db.select().from(recipientTombstones)).length;
}

describe('getRecipientLegalName', () => {
  it('null for no row, a row with no name, a tombstoned row and another tenant', async () => {
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBeNull();
    await repo.upsertRecipient('pa', SENDER, rec());
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBeNull();
    await repo.upsertRecipient('pa', SENDER, rec(), { legalName: NAME });
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBe(NAME);
    expect(await repo.getRecipientLegalName('pb', SENDER, RP)).toBeNull();
    expect(await repo.getRecipientLegalName('pa', '14155550202', RP)).toBeNull();
    await repo.tombstoneRecipient('pa', SENDER, RP);
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBeNull();
  });

  it('with match: the name only when the payout method and the last4 of match.payoutDestination equal the row\'s', async () => {
    await repo.upsertRecipient('pa', SENDER, rec(), { legalName: NAME });
    // Same last4 (2222), different formatting: still the same account by the repo's own last4.
    expect(await repo.getRecipientLegalName('pa', SENDER, RP, { payoutMethod: 'bank', payoutDestination: 'HDFC0000001 000011112222' })).toBe(NAME);
    expect(await repo.getRecipientLegalName('pa', SENDER, RP, { payoutMethod: 'bank', payoutDestination: '0000-1111-2222' })).toBe(NAME);
    expect(await repo.getRecipientLegalName('pa', SENDER, RP, { payoutMethod: 'bank', payoutDestination: 'HDFC0000001 999911119999' })).toBeNull();
    expect(await repo.getRecipientLegalName('pa', SENDER, RP, { payoutMethod: 'upi', payoutDestination: 'HDFC0000001 000011112222' })).toBeNull();
    expect(await repo.getRecipientLegalName('pa', SENDER, RP, { payoutMethod: 'bank', payoutDestination: '' })).toBeNull();
  });

  it('a match read never decrypts the destination (only the name column is opened)', async () => {
    await repo.upsertRecipient('pa', SENDER, rec(), { legalName: NAME });
    const stop = captureQueries();
    await repo.getRecipientLegalName('pa', SENDER, RP, { payoutMethod: 'bank', payoutDestination: 'HDFC0000001 000011112222' });
    const q = stop();
    expect(q).toHaveLength(1);
    expect(q[0].sql).toContain('"legal_name_enc"');
    expect(q[0].sql).not.toContain('"payout_destination_enc"');
  });
});

describe('upsertRecipient with opts.legalName', () => {
  it('seals it under recipients|legal_name_enc (v2.k0. blob, raw column never the plaintext) and getRecipientLegalName opens it', async () => {
    await repo.upsertRecipient('pa', SENDER, rec(), { legalName: `  ${NAME}  ` });
    const raw = await rawLegal();
    expect(raw).toMatch(/^v2\.k0\./);
    expect(raw).not.toContain(NAME);
    expect(decryptField(raw!, provider, ctx.recipient('pa', SENDER, RP, 'legal_name_enc'))).toBe(NAME);
    // The payout context does not open it (the column is bound into the AAD).
    expect(() => decryptField(raw!, provider, ctx.recipient('pa', SENDER, RP))).toThrow();
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBe(NAME);
  });

  it('a blank name is treated as no name (nothing sealed)', async () => {
    await repo.upsertRecipient('pa', SENDER, rec(), { legalName: '   ' });
    expect(await rawLegal()).toBeNull();
  });

  it('a same-account re-save WITHOUT a name keeps the saved name', async () => {
    await repo.upsertRecipient('pa', SENDER, rec({ lastUsedAt: at(10) }), { legalName: NAME });
    await repo.upsertRecipient('pa', SENDER, rec({ name: 'Mother' }));
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBe(NAME);
    expect((await repo.getRecipient('pa', SENDER, RP))?.name).toBe('Mother');
  });

  it('the keepTombstone branch never touches it (its conflict set stays lastUsedAt only)', async () => {
    await repo.upsertRecipient('pa', SENDER, rec({ lastUsedAt: at(10) }), { legalName: NAME });
    const stop = captureQueries();
    await repo.upsertRecipient('pa', SENDER, rec({ payoutDestination: 'HDFC0000009 999988887777' }), { keepTombstone: true });
    const q = stop();
    expect(q).toHaveLength(1);
    // drizzle lists every column in INSERT (default for unset ones); the conflict SET must not name it.
    const conflictSet = q[0].sql.slice(q[0].sql.indexOf('on conflict'));
    expect(conflictSet).toContain('"last_used_at"');
    expect(conflictSet).not.toContain('legal_name_enc');
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBe(NAME);
    // A given name rides VALUES only: an existing row keeps its own name.
    await repo.upsertRecipient('pa', SENDER, rec(), { keepTombstone: true, legalName: 'Someone Else' });
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBe(NAME);
    // ...and a missing row is saved in full, name included.
    await repo.upsertRecipient('pa', SENDER, rec({ recipientPhone: '919000000009' }), { keepTombstone: true, legalName: 'New Person' });
    expect(await repo.getRecipientLegalName('pa', SENDER, '919000000009')).toBe('New Person');
  });

  it('a keepTombstone refresh of a tombstoned row keeps the tombstone and the name', async () => {
    await repo.upsertRecipient('pa', SENDER, rec(), { legalName: NAME });
    await repo.tombstoneRecipient('pa', SENDER, RP);
    await repo.upsertRecipient('pa', SENDER, rec(), { keepTombstone: true });
    expect(await tombstoneCount()).toBe(1);
    expect(await rawLegal()).not.toBeNull();
  });

  it.each<[string, Partial<Recipient>]>([
    ['another last4', { payoutDestination: 'HDFC0000001 000011119999' }],
    ['another payout method', { payoutMethod: 'upi', payoutDestination: 'mom2222@upi' }],
    ['an emptied destination', { payoutDestination: '' }],
  ])('a re-save with %s and no name clears the saved name (NULL)', async (_n, over) => {
    await repo.upsertRecipient('pa', SENDER, rec({ lastUsedAt: at(10) }), { legalName: NAME });
    await repo.upsertRecipient('pa', SENDER, rec(over));
    expect(await rawLegal()).toBeNull();
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBeNull();
  });

  it('an un-delete (tombstoned row re-saved by the full branch, O5) with no name clears the saved name and removes the tombstone', async () => {
    await repo.upsertRecipient('pa', SENDER, rec({ lastUsedAt: at(10) }), { legalName: NAME });
    await repo.tombstoneRecipient('pa', SENDER, RP);
    await repo.upsertRecipient('pa', SENDER, rec()); // same account
    expect(await tombstoneCount()).toBe(0);
    expect(await rawLegal()).toBeNull();
    expect((await repo.getRecipient('pa', SENDER, RP))?.name).toBe('Mom');
  });

  it('an upsert WITH a name sets it whatever the account (and on an un-delete)', async () => {
    await repo.upsertRecipient('pa', SENDER, rec({ lastUsedAt: at(10) }), { legalName: NAME });
    await repo.upsertRecipient('pa', SENDER, rec({ payoutMethod: 'upi', payoutDestination: 'x@upi' }), { legalName: 'Second Name' });
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBe('Second Name');
    await repo.tombstoneRecipient('pa', SENDER, RP);
    await repo.upsertRecipient('pa', SENDER, rec(), { legalName: 'Third Name' });
    expect(await tombstoneCount()).toBe(0);
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBe('Third Name');
  });

  it('is tenant-scoped: another tenant\'s upsert for the same sender and recipient never touches the name', async () => {
    await repo.upsertRecipient('pa', SENDER, rec(), { legalName: NAME });
    await repo.upsertRecipient('pb', SENDER, rec({ payoutMethod: 'upi', payoutDestination: 'y@upi' }));
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBe(NAME);
    expect(await repo.getRecipientLegalName('pb', SENDER, RP)).toBeNull();
  });
});

describe('updateLiveRecipient and the saved name', () => {
  it('with opts.legalName sets it', async () => {
    await repo.upsertRecipient('pa', SENDER, rec());
    expect(await repo.updateLiveRecipient('pa', SENDER, rec({ name: 'Ma' }), { legalName: NAME })).toBe(true);
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBe(NAME);
    expect(await rawLegal()).toMatch(/^v2\.k0\./);
  });

  it('without a name and the same account, keeps it', async () => {
    await repo.upsertRecipient('pa', SENDER, rec(), { legalName: NAME });
    expect(await repo.updateLiveRecipient('pa', SENDER, rec({ name: 'Ma' }))).toBe(true);
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBe(NAME);
  });

  it.each<[string, Partial<Recipient>]>([
    ['a changed last4', { payoutDestination: 'HDFC0000001 000011113333' }],
    ['a changed method', { payoutMethod: 'upi', payoutDestination: 'ma2222@upi' }],
  ])('without a name and %s, clears it', async (_n, over) => {
    await repo.upsertRecipient('pa', SENDER, rec(), { legalName: NAME });
    expect(await repo.updateLiveRecipient('pa', SENDER, rec(over))).toBe(true);
    expect(await rawLegal()).toBeNull();
  });

  it('on a tombstoned row writes nothing (false)', async () => {
    await repo.upsertRecipient('pa', SENDER, rec(), { legalName: NAME });
    const before = await rawLegal();
    await repo.tombstoneRecipient('pa', SENDER, RP);
    expect(await repo.updateLiveRecipient('pa', SENDER, rec(), { legalName: 'Other' })).toBe(false);
    expect(await repo.updateLiveRecipient('pa', SENDER, rec({ payoutMethod: 'upi', payoutDestination: 'z@upi' }))).toBe(false);
    expect(await rawLegal()).toBe(before);
  });
});

// Review R1-P2 D2/E1/F1: the fill names the account that was PAID (bound to it, like the reader).
const PAID = { payoutMethod: 'bank' as const, payoutDestination: 'HDFC0000001 000011112222' };

describe('fillRecipientLegalName', () => {
  it('fills only an empty live row: true once, then false when a name exists (unchanged)', async () => {
    await repo.upsertRecipient('pa', SENDER, rec({ lastUsedAt: at(10) }));
    const lastUsedBefore = (await repo.getRecipient('pa', SENDER, RP))?.lastUsedAt;
    expect(await repo.fillRecipientLegalName('pa', SENDER, RP, `  ${NAME} `, PAID)).toBe(true);
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBe(NAME);
    expect(await repo.fillRecipientLegalName('pa', SENDER, RP, 'Someone Else', PAID)).toBe(false);
    expect(await repo.getRecipientLegalName('pa', SENDER, RP)).toBe(NAME);
    expect((await repo.getRecipient('pa', SENDER, RP))?.lastUsedAt).toBe(lastUsedBefore);
  });

  it('false when tombstoned (never un-deletes: the tombstone stays)', async () => {
    await repo.upsertRecipient('pa', SENDER, rec());
    await repo.tombstoneRecipient('pa', SENDER, RP);
    expect(await repo.fillRecipientLegalName('pa', SENDER, RP, NAME, PAID)).toBe(false);
    expect(await tombstoneCount()).toBe(1);
    expect(await rawLegal()).toBeNull();
  });

  it('false when missing, for another tenant, and for a blank name with no query', async () => {
    expect(await repo.fillRecipientLegalName('pa', SENDER, RP, NAME, PAID)).toBe(false);
    await repo.upsertRecipient('pa', SENDER, rec());
    expect(await repo.fillRecipientLegalName('pb', SENDER, RP, NAME, PAID)).toBe(false);
    expect(await rawLegal()).toBeNull();
    const stop = captureQueries();
    expect(await repo.fillRecipientLegalName('pa', SENDER, RP, '   ', PAID)).toBe(false);
    expect(stop()).toHaveLength(0);
  });

  it('review R1-P2 D2: a book row on ANOTHER account (method or last 4) is never filled; the same account is', async () => {
    await repo.upsertRecipient('pa', SENDER, rec());
    expect(await repo.fillRecipientLegalName('pa', SENDER, RP, NAME, { payoutMethod: 'bank', payoutDestination: 'HDFC0000001 000099995555' })).toBe(false);
    expect(await repo.fillRecipientLegalName('pa', SENDER, RP, NAME, { payoutMethod: 'upi', payoutDestination: 'x2222@upi' })).toBe(false);
    expect(await rawLegal()).toBeNull();
    expect(await repo.fillRecipientLegalName('pa', SENDER, RP, NAME, PAID)).toBe(true);
    expect(await repo.getRecipientLegalName('pa', SENDER, RP, PAID)).toBe(NAME);
  });

  it('review R1-P2 D2: an empty paid account writes nothing and makes no query', async () => {
    await repo.upsertRecipient('pa', SENDER, rec());
    const stop = captureQueries();
    expect(await repo.fillRecipientLegalName('pa', SENDER, RP, NAME, { payoutMethod: 'bank', payoutDestination: '' })).toBe(false);
    expect(stop()).toHaveLength(0);
    expect(await rawLegal()).toBeNull();
  });
});

describe('the generic Recipient never carries the name', () => {
  it('toRecipient / listRecipients / listAllForSender / getRecipient', async () => {
    await repo.upsertRecipient('pa', SENDER, rec(), { legalName: NAME });
    const one = await repo.getRecipient('pa', SENDER, RP);
    expect(one).not.toBeNull();
    expect(one).not.toHaveProperty('legalName');
    expect(one).not.toHaveProperty('legalNameEnc');
    const list = await repo.listRecipients('pa', SENDER, 25);
    const all = await repo.listAllForSender('pa', SENDER);
    for (const r of [...list, ...all]) {
      expect(r).not.toHaveProperty('legalName');
      expect(r).not.toHaveProperty('legalNameEnc');
    }
    expect(JSON.stringify([one, list, all])).not.toContain(NAME);
  });
});
