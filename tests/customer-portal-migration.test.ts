import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { createRecipientRepo } from '@/db/repos/aux-repos';
import { EnvKeyProvider } from '@/lib/field-crypto';
import type { Db } from '@/db/client';

// UI redesign M2-3 (migration 0027, MIGRATION-ONLY): three NEW, empty tables with no reader or
// writer yet. NEW TABLES ONLY: no existing table changes, so the build already in production
// (which selects every schema column of recipients/customers/partners/partner_sites) is unaffected
// during the rolling release. These pin the new shapes, the constraints and that invariant.
type Rows<T> = { rows: T[] };
const rows = async <T>(db: Db, q: string): Promise<T[]> => ((await db.execute(sql.raw(q))) as unknown as Rows<T>).rows;
const exec = (db: Db, q: string) => db.execute(sql.raw(q));
// Pin the SQLSTATE so a rejection can't pass vacuously (e.g. 42P01 "relation does not exist").
const PG = { fk: '23503', unique: '23505', check: '23514' } as const;
const rejectsWith = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; cause?: { code?: string } });
  expect(err, 'expected the statement to be rejected').not.toBeNull();
  expect(err?.code ?? err?.cause?.code).toBe(code);
};
const columns = (db: Db, table: string) =>
  rows<{ column_name: string; data_type: string; is_nullable: string }>(db,
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`,
  ).then((cs) => cs.map((c) => [c.column_name, c.data_type, c.is_nullable]));

const NEW_TABLES = ['partner_portal_settings', 'recipient_tombstones', 'customer_portal_prefs'];
const TS = 'timestamp with time zone';
const SENDER = '15551230000';

const seedCustomer = (db: Db, partnerId: string, phone: string) =>
  exec(db, `INSERT INTO customers (partner_id, phone, first_seen_at, sender_country) VALUES ('${partnerId}', '${phone}', now(), 'US')`);
const seedRecipient = (db: Db, partnerId: string, sender: string, recipient: string) =>
  exec(db, `INSERT INTO recipients (partner_id, sender_phone, recipient_phone, name, payout_method, payout_destination_enc, last_used_at)
            VALUES ('${partnerId}', '${sender}', '${recipient}', 'R', 'bank', 'x', now())`);
const setTemplate = (db: Db, name: string | null, lang: string | null) =>
  exec(db, `INSERT INTO partner_portal_settings (partner_id, auth_template_name, auth_template_lang)
            VALUES ('default', ${name === null ? 'NULL' : `'${name}'`}, ${lang === null ? 'NULL' : `'${lang}'`})`);

describe('partner_portal_settings (migration 0027)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('has the agreed columns, types and nullability', async () => {
    expect(await columns(db, 'partner_portal_settings')).toEqual([
      ['partner_id', 'text', 'NO'],
      ['auth_template_name', 'text', 'YES'],
      ['auth_template_lang', 'text', 'YES'],
      ['portal_enabled_at', TS, 'YES'],
      ['created_at', TS, 'NO'],
      ['updated_at', TS, 'NO'],
    ]);
  });
  it('partner_id is the PK and an FK to partners (unknown partner rejected)', async () => {
    await setTemplate(db, null, null); // both template columns nullable
    await rejectsWith(setTemplate(db, 'login_code', 'en'), PG.unique); // one settings row per partner
    await rejectsWith(exec(db, `INSERT INTO partner_portal_settings (partner_id) VALUES ('no-such-partner')`), PG.fk);
  });
  it.each(['Bad Name', 'x;drop', '', 'Login', 'a'.repeat(513)])('CHECK rejects auth_template_name %j', async (n) => {
    await rejectsWith(setTemplate(db, n, null), PG.check);
  });
  it.each(['login_code', 'otp2', 'a'.repeat(512)])('CHECK accepts auth_template_name %j', async (n) => {
    await setTemplate(db, n, null);
  });
  it.each(['EN', 'en-US', 'english', '', 'en_us', 'e'])('CHECK rejects auth_template_lang %j', async (l) => {
    await rejectsWith(setTemplate(db, null, l), PG.check);
  });
  it.each(['en', 'en_US', 'hi'])('CHECK accepts auth_template_lang %j', async (l) => {
    await setTemplate(db, null, l);
  });
});

describe('recipient_tombstones (migration 0027)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });
  const tomb = (partnerId: string, sender: string, recipient: string) =>
    exec(db, `INSERT INTO recipient_tombstones (partner_id, sender_phone, recipient_phone) VALUES ('${partnerId}', '${sender}', '${recipient}')`);

  it('has the agreed columns, types and nullability', async () => {
    expect(await columns(db, 'recipient_tombstones')).toEqual([
      ['partner_id', 'text', 'NO'],
      ['sender_phone', 'text', 'NO'],
      ['recipient_phone', 'text', 'NO'],
      ['deleted_at', TS, 'NO'],
    ]);
  });
  it('the PK rejects a duplicate tombstone; deleted_at defaults', async () => {
    await seedRecipient(db, 'default', SENDER, '91A');
    await tomb('default', SENDER, '91A');
    await rejectsWith(tomb('default', SENDER, '91A'), PG.unique);
    const [r] = await rows<{ n: number }>(db, `SELECT count(*)::int AS n FROM recipient_tombstones WHERE deleted_at IS NOT NULL`);
    expect(r.n).toBe(1);
  });
  it('the FK rejects an unknown recipient key (including another tenant\'s key)', async () => {
    await seedRecipient(db, 'default', SENDER, '91A');
    await rejectsWith(tomb('default', SENDER, '91B'), PG.fk);
    await exec(db, `INSERT INTO partners (id, name) VALUES ('acme', 'Acme')`);
    await rejectsWith(tomb('acme', SENDER, '91A'), PG.fk);
  });
});

describe('customer_portal_prefs (migration 0027)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });
  const pref = (partnerId: string, phone: string) =>
    exec(db, `INSERT INTO customer_portal_prefs (partner_id, phone) VALUES ('${partnerId}', '${phone}')`);

  it('has the agreed columns, types and nullability', async () => {
    expect(await columns(db, 'customer_portal_prefs')).toEqual([
      ['partner_id', 'text', 'NO'],
      ['phone', 'text', 'NO'],
      ['email_receipts', 'boolean', 'NO'],
      ['email_verified_at', TS, 'YES'],
      ['email_verified_tag', 'text', 'YES'],
      ['created_at', TS, 'NO'],
      ['updated_at', TS, 'NO'],
    ]);
  });
  it('the PK rejects a duplicate; email_receipts defaults to false', async () => {
    await seedCustomer(db, 'default', SENDER);
    await pref('default', SENDER);
    await rejectsWith(pref('default', SENDER), PG.unique);
    const [r] = await rows<{ email_receipts: boolean }>(db, `SELECT email_receipts FROM customer_portal_prefs`);
    expect(r.email_receipts).toBe(false);
  });
  it('the FK rejects an unknown (partner_id, phone), including another tenant\'s customer', async () => {
    await seedCustomer(db, 'default', SENDER);
    await rejectsWith(pref('default', '15559999999'), PG.fk);
    await exec(db, `INSERT INTO partners (id, name) VALUES ('acme', 'Acme')`);
    await rejectsWith(pref('acme', SENDER), PG.fk);
  });
});

describe('migration 0027 is NEW TABLES ONLY (safe for the build already in production)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  // Captured from the migrated DB at 0026, BEFORE this migration existed. A changed list means an
  // existing table was altered, which the old build's db.select().from(t) would break on.
  it('the column lists of the existing tables are unchanged', async () => {
    expect(await columns(db, 'recipients')).toEqual([["sender_phone","text","NO"],["recipient_phone","text","NO"],["name","text","NO"],["payout_method","text","NO"],["payout_destination_enc","text","NO"],["payout_destination_last4","text","NO"],["last_used_at",TS,"NO"],["partner_id","text","NO"]]);
    expect(await columns(db, 'partner_sites')).toEqual([["partner_id","text","NO"],["slug","text","YES"],["accent_color","text","YES"],["created_at",TS,"NO"],["updated_at",TS,"NO"]]);
    expect(await columns(db, 'partners')).toEqual([["id","text","NO"],["name","text","NO"],["status","text","NO"],["countries","jsonb","NO"],["brand_name","text","YES"],["display_name","text","YES"],["primary_color","text","YES"],["logo_url","text","YES"],["support_contact","text","YES"],["bot_persona","text","YES"],["admin_note","text","YES"],["kyc_mode","text","NO"],["require_kyc_before_send","boolean","YES"],["corridor_compliance","jsonb","YES"],["created_at",TS,"NO"],["updated_at",TS,"NO"],["support_config","jsonb","YES"],["send_limits","jsonb","YES"]]);
    expect(await columns(db, 'customers')).toEqual([["phone","text","NO"],["partner_id","text","NO"],["first_seen_at",TS,"NO"],["sender_country","text","NO"],["kyc_status","text","NO"],["kyc_review_state","text","YES"],["kyc_inquiry_id","text","YES"],["kyc_provider_ref","text","YES"],["kyc_rejected_reason","text","YES"],["kyc_verified_at",TS,"YES"],["kyc_submitted_at",TS,"YES"],["kyc_approved_by","text","YES"],["kyc_approved_at",TS,"YES"],["kyc_rejected_at",TS,"YES"],["full_name_enc","text","YES"],["date_of_birth_enc","text","YES"],["residential_address_enc","text","YES"],["email_enc","text","YES"],["gov_id_number_enc","text","YES"],["gov_id_type","text","YES"],["id_last4","text","YES"],["id_doc_type","text","YES"],["nationality","text","YES"],["pep_declared","boolean","YES"],["watchlist_hit","boolean","YES"],["pep_hit","boolean","YES"],["source_of_funds","text","YES"],["occupation","text","YES"],["edd_captured_at",TS,"YES"],["last_funding_method","text","YES"],["last_funding_method_at",TS,"YES"],["password_hash","text","YES"],["password_updated_at",TS,"YES"],["phone_verified_at",TS,"YES"],["opt_in_at",TS,"YES"],["opted_out_at",TS,"YES"],["created_at",TS,"NO"],["updated_at",TS,"NO"],["send_limit_override","jsonb","YES"],["mfa_totp_enc","text","YES"],["mfa_enrolled_at",TS,"YES"]]);
  });

  it('the SQL only creates the three new tables; every ALTER TABLE adds an FK to a NEW table', () => {
    const text = readFileSync(join(process.cwd(), 'drizzle/0027_customer_portal.sql'), 'utf8');
    const code = text.split('\n').filter((l) => !l.startsWith('--')).join('\n');
    expect([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual([...NEW_TABLES].sort());
    const alters = [...code.matchAll(/ALTER TABLE "([a-z_]+)"([^;]*);/g)];
    expect(alters.length).toBe(3);
    for (const [, table, rest] of alters) {
      expect(NEW_TABLES).toContain(table);
      expect(rest).toMatch(/^ ADD CONSTRAINT "[a-z_]+" FOREIGN KEY /);
      // No cascade yet: loop A's erasure engine decides cascade vs purge order (see the SQL header).
      expect(rest).toMatch(/ ON DELETE no action ON UPDATE no action$/);
    }
    expect(code).not.toMatch(/\b(DROP|RENAME|ALTER COLUMN|INSERT|TRUNCATE)\b/i);
    expect(code).toContain(`SET LOCAL lock_timeout = '5s';`);
  });

  it('the drizzle snapshot keeps every 0026 table byte-identical and adds only the three new ones', () => {
    const snap = (n: string) => JSON.parse(readFileSync(join(process.cwd(), `drizzle/meta/${n}_snapshot.json`), 'utf8')) as { tables: Record<string, unknown> };
    const before = snap('0026').tables;
    const after = snap('0027').tables;
    for (const [k, v] of Object.entries(before)) expect(after[k], k).toEqual(v);
    expect(Object.keys(after).filter((k) => !(k in before)).sort()).toEqual(NEW_TABLES.map((t) => `public.${t}`).sort());
  });

  it('the existing recipients writer and reader still round-trip unchanged', async () => {
    const r = createRecipientRepo(db, new EnvKeyProvider(Buffer.alloc(32, 7)));
    await r.upsertRecipient('default', SENDER, { name: 'A', recipientPhone: '91A', payoutMethod: 'bank', payoutDestination: '111122223333', lastUsedAt: '2026-06-01T00:00:00.000Z' });
    const list = await r.listRecipients('default', SENDER, 5);
    expect(list).toEqual([{ name: 'A', recipientPhone: '91A', payoutMethod: 'bank', payoutDestination: '111122223333', lastUsedAt: '2026-06-01T00:00:00.000Z' }]);
  });

  it('every new constraint name fits the 63-byte identifier limit and matches the snapshot', async () => {
    const cons = await rows<{ conname: string; contype: string }>(db,
      `SELECT conname, contype FROM pg_constraint WHERE conrelid::regclass::text IN ('partner_portal_settings','recipient_tombstones','customer_portal_prefs') AND contype IN ('p','f','c','u') ORDER BY conname`);
    expect(cons).toEqual([
      { conname: 'customer_portal_prefs_customer_fk', contype: 'f' },
      { conname: 'customer_portal_prefs_partner_id_phone_pk', contype: 'p' },
      { conname: 'partner_portal_settings_partner_id_partners_id_fk', contype: 'f' },
      { conname: 'partner_portal_settings_pkey', contype: 'p' },
      { conname: 'partner_portal_settings_template_lang_format', contype: 'c' },
      { conname: 'partner_portal_settings_template_name_format', contype: 'c' },
      { conname: 'recipient_tombstones_partner_id_sender_phone_recipient_phone_pk', contype: 'p' },
      { conname: 'recipient_tombstones_recipient_fk', contype: 'f' },
    ]);
  });
});
