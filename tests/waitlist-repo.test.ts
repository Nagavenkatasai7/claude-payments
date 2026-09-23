import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { createWaitlistRepo } from '@/db/repos/waitlist-repo';
import { decryptField, EnvKeyProvider } from '@/lib/field-crypto';
import { blindIndex, deriveBlindIndexKey } from '@/lib/blind-index';

/**
 * waitlist-repo (PGlite) — the storage contract for waitlist_signups:
 *   • no plaintext PII in any column (asserted on the RAW row),
 *   • blind indexes are KEYED (≠ sha256 of the value) and UNIQUE ⇒ dedupe,
 *   • list reads are masked and never decrypt; the export read is explicit.
 */

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const SIGNUP = {
  id: 'wl_1',
  fullName: 'Asha Patel',
  email: 'asha.patel@example.com',
  phone: '+15551234567',
  location: 'Fairfax, VA',
  destinations: ['IN', 'MX'],
  consentAt: '2026-09-21T10:00:00.000Z',
  consentTextVersion: 'v1',
  utmSource: 'newsletter',
  utmCampaign: undefined,
};

type RawRow = Record<string, string | null>;
async function rawRows(): Promise<RawRow[]> {
  const res = await db.execute(sql`SELECT * FROM waitlist_signups ORDER BY created_at`);
  return (res as unknown as { rows: RawRow[] }).rows;
}

describe('createWaitlistRepo.insertIfNew', () => {
  it('stores ciphertext + keyed blind indexes + masks — and NO plaintext PII in any column', async () => {
    const repo = createWaitlistRepo(db);
    expect(await repo.insertIfNew(SIGNUP)).toBe(true);

    const [row] = await rawRows();
    // Every PII column is a context-bound field-crypto v2 blob (Program-Fix 46B).
    for (const col of ['full_name_enc', 'email_enc', 'phone_enc', 'location_enc']) {
      expect(row[col]).toMatch(/^v2\.k0\./);
    }
    // Nothing in the raw row equals (or contains) a plaintext PII value.
    const dump = JSON.stringify(row);
    expect(dump).not.toContain('Asha Patel');
    expect(dump).not.toContain('asha.patel@example.com');
    expect(dump).not.toContain('15551234567');
    expect(dump).not.toContain('Fairfax');
    // Blind indexes are the KEYED HMAC — never an unkeyed hash of the value.
    const key = deriveBlindIndexKey();
    expect(row.email_bidx).toBe(blindIndex('email', 'asha.patel@example.com', key));
    expect(row.phone_bidx).toBe(blindIndex('phone', '+15551234567', key));
    expect(row.email_bidx).not.toBe(createHash('sha256').update('asha.patel@example.com').digest('hex'));
    expect(row.phone_bidx).not.toBe(createHash('sha256').update('+15551234567').digest('hex'));
    // Masks are the only plain derivatives.
    expect(row.name_initial).toBe('A.');
    expect(row.email_masked).toBe('a***@example.com');
    expect(row.phone_last4).toBe('4567');
    expect(row.consent_text_version).toBe('v1');
    expect(row.utm_source).toBe('newsletter');
    expect(row.utm_campaign).toBeNull();
    // The ciphertext round-trips under the default provider.
    expect(decryptField(row.full_name_enc!)).toBe('Asha Patel');
  });

  it('dedupes on email: a second signup with the same normalised email is a silent no-op (returns false, one row)', async () => {
    const repo = createWaitlistRepo(db);
    expect(await repo.insertIfNew(SIGNUP)).toBe(true);
    expect(await repo.insertIfNew({ ...SIGNUP, id: 'wl_2', phone: '+15559990000' })).toBe(false);
    expect(await rawRows()).toHaveLength(1);
  });

  it('dedupes on phone: same E.164 phone with a different email is a silent no-op', async () => {
    const repo = createWaitlistRepo(db);
    expect(await repo.insertIfNew(SIGNUP)).toBe(true);
    expect(await repo.insertIfNew({ ...SIGNUP, id: 'wl_2', email: 'other@example.com' })).toBe(false);
    expect(await rawRows()).toHaveLength(1);
  });

  it('a genuinely new person (new email AND new phone) is inserted', async () => {
    const repo = createWaitlistRepo(db);
    await repo.insertIfNew(SIGNUP);
    expect(await repo.insertIfNew({ ...SIGNUP, id: 'wl_2', email: 'b@example.com', phone: '+15559990000' })).toBe(true);
    expect(await rawRows()).toHaveLength(2);
  });

  it('a different master key yields different blind indexes (the index is keyed from the master)', async () => {
    const other = new EnvKeyProvider('11'.repeat(32));
    const repo = createWaitlistRepo(db, other, deriveBlindIndexKey('11'.repeat(32)));
    await repo.insertIfNew(SIGNUP);
    const [row] = await rawRows();
    expect(row.email_bidx).not.toBe(blindIndex('email', 'asha.patel@example.com', deriveBlindIndexKey()));
    expect(() => decryptField(row.email_enc!)).toThrow(); // sealed under the other key
    expect(decryptField(row.email_enc!, other)).toBe('asha.patel@example.com');
  });
});

describe('reads', () => {
  it('listMasked returns masked rows newest-first and exposes no ciphertext or plaintext', async () => {
    const repo = createWaitlistRepo(db);
    await repo.insertIfNew(SIGNUP);
    await repo.insertIfNew({ ...SIGNUP, id: 'wl_2', email: 'b@gmail.com', phone: '+15559990000', fullName: 'bob' });
    await db.execute(sql`UPDATE waitlist_signups SET created_at = created_at + interval '1 minute' WHERE id = 'wl_2'`);

    const rows = await repo.listMasked();
    expect(rows.map((r) => r.id)).toEqual(['wl_2', 'wl_1']);
    expect(rows[1]).toEqual({
      id: 'wl_1',
      nameInitial: 'A.',
      emailMasked: 'a***@example.com',
      phoneLast4: '4567',
      destinations: ['IN', 'MX'],
      consentAt: '2026-09-21T10:00:00.000Z',
      consentTextVersion: 'v1',
      utmSource: 'newsletter',
      utmCampaign: undefined,
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(rows)).not.toMatch(/v[12]\.|Asha|asha\.patel|15551234567/);
  });

  it('countsByDestination counts each country across signups and the total', async () => {
    const repo = createWaitlistRepo(db);
    await repo.insertIfNew(SIGNUP); // IN, MX
    await repo.insertIfNew({ ...SIGNUP, id: 'wl_2', email: 'b@x.co', phone: '+15559990000', destinations: ['IN'] });
    await repo.insertIfNew({ ...SIGNUP, id: 'wl_3', email: 'c@x.co', phone: '+15559990001', destinations: ['GB'] });
    expect(await repo.countsByDestination()).toEqual({ total: 3, byCountry: { IN: 2, MX: 1, GB: 1 } });
  });

  it('listDecrypted (the explicit export read) opens every PII field', async () => {
    const repo = createWaitlistRepo(db);
    await repo.insertIfNew(SIGNUP);
    const [r] = await repo.listDecrypted();
    expect(r).toEqual({
      id: 'wl_1',
      fullName: 'Asha Patel',
      email: 'asha.patel@example.com',
      phone: '+15551234567',
      location: 'Fairfax, VA',
      destinations: ['IN', 'MX'],
      consentAt: '2026-09-21T10:00:00.000Z',
      consentTextVersion: 'v1',
      utmSource: 'newsletter',
      utmCampaign: undefined,
      createdAt: expect.any(String),
    });
  });
});
