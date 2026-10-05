import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { freshDb } from './helpers-db';
import { createStaffRepo } from '@/db/repos/staff-repo';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-7 (migration 0028, MIGRATION-ONLY): four NEW partner-app tables, a backfill that
// only inserts into one of them, and the staff role CHECK widened to a SUPERSET ('finance').
// No column of any existing table changes, so the build already in production (explicit column
// lists via db.select().from(t)) is unaffected during the rolling release, with or without the
// migration applied. No reader or writer of the new tables exists yet.
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

const MIGRATION = 'drizzle/0028_partner_app.sql';
const NEW_TABLES = ['partner_go_live', 'partner_report_jobs', 'partner_slug_tombstones', 'partner_webhook_deliveries'];
const TS = 'timestamp with time zone';
const BACKFILL_BY = 'system:0028-backfill';
const UUID = '00000000-0000-4000-8000-000000000001';

const reportJob = (db: Db, over: { partner?: string; kind?: string; status?: string; id?: string } = {}) =>
  exec(db, `INSERT INTO partner_report_jobs (id, partner_id, kind, params, requested_by${over.status ? ', status' : ''})
            VALUES ('${over.id ?? UUID}', '${over.partner ?? 'default'}', '${over.kind ?? 'settlements'}', '{}'::jsonb, 'pa-admin'${over.status ? `, '${over.status}'` : ''})`);
const delivery = (db: Db, over: { partner?: string; kind?: string; outcome?: string } = {}) =>
  exec(db, `INSERT INTO partner_webhook_deliveries (partner_id, kind, attempt, outcome)
            VALUES ('${over.partner ?? 'default'}', '${over.kind ?? 'ping'}', 1, '${over.outcome ?? 'ok'}')`);
const tombstone = (db: Db, slug: string, partner = 'default') =>
  exec(db, `INSERT INTO partner_slug_tombstones (slug, partner_id, released_by) VALUES ('${slug}', '${partner}', 'platform-admin')`);
const staffRow = (db: Db, username: string, role: string) =>
  exec(db, `INSERT INTO staff (username, partner_id, name, role, permissions, password_hash, created_at)
            VALUES ('${username}', 'default', 'N', '${role}', '{}'::jsonb, 'h', now())`);

describe('migration 0028: the four new tables', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('partner_go_live has the agreed columns; partner_id is the PK and an FK to partners', async () => {
    expect(await columns(db, 'partner_go_live')).toEqual([
      ['partner_id', 'text', 'NO'],
      ['requested_at', TS, 'YES'],
      ['requested_by', 'text', 'YES'],
      ['approved_at', TS, 'YES'],
      ['approved_by', 'text', 'YES'],
      ['updated_at', TS, 'NO'],
    ]);
    await exec(db, `INSERT INTO partner_go_live (partner_id) VALUES ('default')`); // new partners start un-approved
    await rejectsWith(exec(db, `INSERT INTO partner_go_live (partner_id) VALUES ('default')`), PG.unique);
    await rejectsWith(exec(db, `INSERT INTO partner_go_live (partner_id) VALUES ('no-such-partner')`), PG.fk);
  });

  it('partner_report_jobs has the agreed columns, the FK and the kind/status CHECKs', async () => {
    expect(await columns(db, 'partner_report_jobs')).toEqual([
      ['id', 'uuid', 'NO'],
      ['partner_id', 'text', 'NO'],
      ['kind', 'text', 'NO'],
      ['params', 'jsonb', 'NO'],
      ['status', 'text', 'NO'],
      ['requested_by', 'text', 'NO'],
      ['row_count', 'integer', 'YES'],
      ['claimed_at', TS, 'YES'],
      ['content_enc', 'text', 'YES'],
      ['error_code', 'text', 'YES'],
      ['created_at', TS, 'NO'],
      ['completed_at', TS, 'YES'],
      ['expires_at', TS, 'YES'],
    ]);
    await reportJob(db);
    const [r] = await rows<{ status: string }>(db, `SELECT status FROM partner_report_jobs`);
    expect(r.status).toBe('queued');
    await rejectsWith(reportJob(db, { partner: 'no-such-partner', id: '00000000-0000-4000-8000-000000000002' }), PG.fk);
    await rejectsWith(reportJob(db, { kind: 'x', id: '00000000-0000-4000-8000-000000000003' }), PG.check);
    await rejectsWith(reportJob(db, { status: 'x', id: '00000000-0000-4000-8000-000000000004' }), PG.check);
  });

  it.each(['settlements', 'transfers', 'fees_monthly'])('partner_report_jobs accepts kind %j', async (kind) => {
    await reportJob(db, { kind });
  });
  it.each(['queued', 'running', 'ready', 'failed', 'expired'])('partner_report_jobs accepts status %j', async (status) => {
    await reportJob(db, { status });
  });

  it('partner_slug_tombstones: slug is the PK (never reusable), partner_id is an FK', async () => {
    expect(await columns(db, 'partner_slug_tombstones')).toEqual([
      ['slug', 'text', 'NO'],
      ['partner_id', 'text', 'NO'],
      ['released_at', TS, 'NO'],
      ['released_by', 'text', 'NO'],
    ]);
    await tombstone(db, 'acme');
    await rejectsWith(tombstone(db, 'acme'), PG.unique);
    await rejectsWith(tombstone(db, 'other', 'no-such-partner'), PG.fk);
  });

  it('partner_webhook_deliveries has the agreed columns, an identity id, the FK and the kind/outcome CHECKs', async () => {
    expect(await columns(db, 'partner_webhook_deliveries')).toEqual([
      ['id', 'bigint', 'NO'],
      ['partner_id', 'text', 'NO'],
      ['kind', 'text', 'NO'],
      ['subject_id', 'text', 'YES'],
      ['outbox_id', 'bigint', 'YES'],
      ['attempt', 'integer', 'NO'],
      ['outcome', 'text', 'NO'],
      ['http_status', 'integer', 'YES'],
      ['latency_ms', 'integer', 'YES'],
      ['created_at', TS, 'NO'],
    ]);
    const [idCol] = await rows<{ is_identity: string; identity_generation: string }>(db,
      `SELECT is_identity, identity_generation FROM information_schema.columns WHERE table_name = 'partner_webhook_deliveries' AND column_name = 'id'`);
    expect(idCol).toEqual({ is_identity: 'YES', identity_generation: 'ALWAYS' });
    await delivery(db);
    await delivery(db, { kind: 'settlement.instruct', outcome: 'http_error' });
    await delivery(db, { outcome: 'network' });
    await delivery(db, { outcome: 'refused' });
    await rejectsWith(delivery(db, { partner: 'no-such-partner' }), PG.fk);
    await rejectsWith(delivery(db, { kind: 'x' }), PG.check);
    await rejectsWith(delivery(db, { outcome: 'x' }), PG.check);
  });

  it('the two (partner_id, created_at DESC) indexes exist', async () => {
    const idx = await rows<{ indexname: string; indexdef: string }>(db,
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('partner_report_jobs_partner_created','partner_webhook_deliveries_partner_created') ORDER BY indexname`);
    expect(idx.map((i) => i.indexname)).toEqual(['partner_report_jobs_partner_created', 'partner_webhook_deliveries_partner_created']);
    for (const i of idx) expect(i.indexdef).toMatch(/\(partner_id, created_at DESC NULLS LAST\)$/);
  });

  it('every new constraint has the expected name (all within the 63-byte identifier limit)', async () => {
    const cons = await rows<{ conname: string; contype: string }>(db,
      `SELECT conname, contype FROM pg_constraint WHERE conrelid::regclass::text IN (${NEW_TABLES.map((t) => `'${t}'`).join(',')}) AND contype IN ('p','f','c','u') ORDER BY conname`);
    expect(cons).toEqual([
      { conname: 'partner_go_live_partner_id_partners_id_fk', contype: 'f' },
      { conname: 'partner_go_live_pkey', contype: 'p' },
      { conname: 'partner_report_jobs_kind', contype: 'c' },
      { conname: 'partner_report_jobs_partner_id_partners_id_fk', contype: 'f' },
      { conname: 'partner_report_jobs_pkey', contype: 'p' },
      { conname: 'partner_report_jobs_status', contype: 'c' },
      { conname: 'partner_slug_tombstones_partner_id_partners_id_fk', contype: 'f' },
      { conname: 'partner_slug_tombstones_pkey', contype: 'p' },
      { conname: 'partner_webhook_deliveries_kind', contype: 'c' },
      { conname: 'partner_webhook_deliveries_outcome', contype: 'c' },
      { conname: 'partner_webhook_deliveries_partner_id_partners_id_fk', contype: 'f' },
      { conname: 'partner_webhook_deliveries_pkey', contype: 'p' },
    ]);
  });

  it('no plaintext-PII column: the report body is only ever the sealed content_enc', async () => {
    const all = (await Promise.all(NEW_TABLES.map((t) => columns(db, t)))).flat().map((c) => c[0]);
    expect(all.length).toBe(33); // guards a vacuous pass if a table name is wrong
    expect(all.filter((c) => /phone|name|email|address|dob|content(?!_enc)|body|csv/.test(String(c)))).toEqual([]);
  });
});

describe('migration 0028: staff_role_check widened to a superset', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it.each(['admin', 'agent', 'support', 'finance'])('staff accepts role %j', async (role) => {
    await staffRow(db, `u-${role}`, role);
  });
  it.each(['owner', 'Finance', ''])('staff still rejects role %j', async (role) => {
    await rejectsWith(staffRow(db, 'u-bad', role), PG.check);
  });
  it('the CHECK keeps its name and is validated (not left NOT VALID)', async () => {
    const [c] = await rows<{ convalidated: boolean; def: string }>(db,
      `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'staff_role_check'`);
    expect(c.convalidated).toBe(true);
    expect(c.def).toContain(`'finance'`);
  });
});

describe('migration 0028 is safe for the build already in production (rolling release)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  // Captured from the migrated DB at 0027, BEFORE this migration existed. A changed list means an
  // existing table was altered, which the old build's db.select().from(t) would break on.
  it('the column lists of the existing tables are unchanged', async () => {
    expect(await columns(db, 'staff')).toEqual([["username","text","NO"],["partner_id","text","YES"],["name","text","NO"],["role","text","NO"],["permissions","jsonb","NO"],["password_hash","text","NO"],["status","text","NO"],["created_at",TS,"NO"],["last_login_at",TS,"YES"],["updated_at",TS,"NO"]]);
    expect(await columns(db, 'partner_sites')).toEqual([["partner_id","text","NO"],["slug","text","YES"],["accent_color","text","YES"],["created_at",TS,"NO"],["updated_at",TS,"NO"]]);
    expect(await columns(db, 'partner_portal_settings')).toEqual([["partner_id","text","NO"],["auth_template_name","text","YES"],["auth_template_lang","text","YES"],["portal_enabled_at",TS,"YES"],["created_at",TS,"NO"],["updated_at",TS,"NO"]]);
    expect(await columns(db, 'partners')).toEqual([["id","text","NO"],["name","text","NO"],["status","text","NO"],["countries","jsonb","NO"],["brand_name","text","YES"],["display_name","text","YES"],["primary_color","text","YES"],["logo_url","text","YES"],["support_contact","text","YES"],["bot_persona","text","YES"],["admin_note","text","YES"],["kyc_mode","text","NO"],["require_kyc_before_send","boolean","YES"],["corridor_compliance","jsonb","YES"],["created_at",TS,"NO"],["updated_at",TS,"NO"],["support_config","jsonb","YES"],["send_limits","jsonb","YES"]]);
  });

  it('the SQL: CREATEs only the four new tables; ALTERs are FKs on new tables plus the staff CHECK swap; one backfill INSERT', () => {
    const text = readFileSync(join(process.cwd(), MIGRATION), 'utf8');
    const code = text.split('\n').filter((l) => !l.startsWith('--')).join('\n');
    expect([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual([...NEW_TABLES].sort());
    const alters = [...code.matchAll(/ALTER TABLE "([a-z_]+)"([^;]*);/g)];
    const onStaff = alters.filter(([, table]) => table === 'staff').map(([, , rest]) => rest.trim());
    expect(onStaff).toEqual([
      'DROP CONSTRAINT "staff_role_check"',
      `ADD CONSTRAINT "staff_role_check" CHECK ("staff"."role" IN ('admin','agent','support','finance'))`,
    ]);
    const fks = alters.filter(([, table]) => table !== 'staff');
    expect(fks.length).toBe(4);
    for (const [, table, rest] of fks) {
      expect(NEW_TABLES).toContain(table);
      expect(rest).toMatch(/^ ADD CONSTRAINT "[a-z_]+" FOREIGN KEY \("partner_id"\) REFERENCES "public"\."partners"\("id"\) ON DELETE no action ON UPDATE no action$/);
    }
    const inserts = [...code.matchAll(/INSERT INTO "([a-z_]+)"/g)].map((m) => m[1]);
    expect(inserts).toEqual(['partner_go_live']);
    expect(code).not.toMatch(/\b(RENAME|ALTER COLUMN|TRUNCATE|DELETE FROM|ADD COLUMN|UPDATE "|DROP TABLE|DROP COLUMN|DROP INDEX|NOT VALID)\b/i);
    expect(code).toContain(`SET LOCAL lock_timeout = '5s';`);
    // The backfill runs after the FK exists and is re-runnable.
    expect(code.indexOf('INSERT INTO "partner_go_live"')).toBeGreaterThan(code.indexOf('ADD CONSTRAINT "partner_go_live_partner_id_partners_id_fk"'));
    expect(code).toMatch(/ON CONFLICT \("partner_id"\) DO NOTHING/);
  });

  it('the drizzle snapshot keeps every 0027 table identical except the staff role CHECK, and adds only the four new ones', () => {
    const snap = (n: string) => JSON.parse(readFileSync(join(process.cwd(), `drizzle/meta/${n}_snapshot.json`), 'utf8')) as {
      tables: Record<string, { checkConstraints: Record<string, { value: string }> }>;
    };
    const before = snap('0027').tables;
    const after = snap('0028').tables;
    for (const [k, v] of Object.entries(before)) {
      if (k === 'public.staff') continue;
      expect(after[k], k).toEqual(v);
    }
    const staffBefore = structuredClone(before['public.staff']);
    const staffAfter = structuredClone(after['public.staff']);
    expect(staffAfter.checkConstraints.staff_role_check.value).toBe(`"staff"."role" IN ('admin','agent','support','finance')`);
    staffAfter.checkConstraints.staff_role_check.value = staffBefore.checkConstraints.staff_role_check.value;
    expect(staffAfter).toEqual(staffBefore);
    expect(Object.keys(after).filter((k) => !(k in before)).sort()).toEqual(NEW_TABLES.map((t) => `public.${t}`).sort());
  });

  it('the journal appends 0028 after 0027', () => {
    const journal = JSON.parse(readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    // Located by tag, not by position: later migrations (0029+) append after it.
    const at = journal.entries.findIndex((e) => e.tag === '0028_partner_app');
    const [prev, last] = journal.entries.slice(at - 1, at + 1);
    expect(prev.tag).toBe('0027_customer_portal');
    expect(last).toMatchObject({ idx: 28, tag: '0028_partner_app' });
    expect(last.when).toBeGreaterThan(prev.when);
  });

  it('the staff repo (explicit column list) still round-trips with the migration applied', async () => {
    const repo = createStaffRepo(db);
    const s = { username: 'pa-admin', partnerId: 'default', name: 'A', role: 'admin', permissions: {}, passwordHash: 'h', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' } as unknown as Staff;
    await repo.upsert(s);
    expect(await repo.get('pa-admin')).toMatchObject({ username: 'pa-admin', role: 'admin', partnerId: 'default' });
  });
});

// The backfill needs rows that existed BEFORE 0028 ran. freshDb() TRUNCATEs (CASCADE) every table,
// which would also wipe the backfilled rows, so this suite migrates its own PGlite in two steps:
// 0000..0027 from a copy of drizzle/ with the journal cut at 0027, then the real folder. The
// migrator applies only entries whose journal `when` is newer than the last applied one
// (node_modules/drizzle-orm/pg-core/dialect.js:56-70; readMigrationFiles, migrator.js:12-24).
describe('migration 0028: the go-live backfill (grandfathers every existing partner)', () => {
  let pre: Db; // the DB at 0027 (no 0028): the "new build before /migrate-prod" state
  let post: Db;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-0027-'));
    cpSync(join(process.cwd(), 'drizzle'), dir, { recursive: true });
    const journalPath = join(dir, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
    const cut = journal.entries.findIndex((e) => e.tag === '0027_customer_portal');
    expect(cut).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, cut + 1);
    writeFileSync(journalPath, JSON.stringify(journal));

    const client = new PGlite();
    const d = drizzle(client, { schema });
    await migrate(d, { migrationsFolder: dir });
    pre = d as unknown as Db;
    await exec(pre, `INSERT INTO partners (id, name) VALUES ('acme', 'Acme'), ('beta', 'Beta')`);

    // Before 0028: no go-live table; the new build's staff repo still works on the old schema.
    await rejectsWith(exec(pre, `SELECT 1 FROM partner_go_live`), '42P01');
    const repo = createStaffRepo(pre);
    await repo.upsert({ username: 'pre-admin', partnerId: 'acme', name: 'A', role: 'admin', permissions: {}, passwordHash: 'h', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' } as unknown as Staff);
    expect(await repo.get('pre-admin')).toMatchObject({ role: 'admin', partnerId: 'acme' });
    // ...and the old CHECK still refuses 'finance' until the migration is applied.
    await rejectsWith(staffRow(pre, 'pre-fin', 'finance'), PG.check);

    await migrate(d, { migrationsFolder: join(process.cwd(), 'drizzle') });
    post = d as unknown as Db;
  });

  it('each partner that existed before 0028 gets exactly one approved row', async () => {
    const r = await rows<{ partner_id: string; approved_by: string; approved: boolean; requested_at: string | null }>(post,
      `SELECT partner_id, approved_by, approved_at IS NOT NULL AS approved, requested_at FROM partner_go_live ORDER BY partner_id`);
    expect(r).toEqual([
      { partner_id: 'acme', approved_by: BACKFILL_BY, approved: true, requested_at: null },
      { partner_id: 'beta', approved_by: BACKFILL_BY, approved: true, requested_at: null },
      { partner_id: 'default', approved_by: BACKFILL_BY, approved: true, requested_at: null },
    ]);
  });

  it('re-running the backfill only adds partners created since, and never touches an existing row', async () => {
    const text = readFileSync(join(process.cwd(), MIGRATION), 'utf8');
    const stmt = text.split('--> statement-breakpoint').find((s) => s.includes('INSERT INTO "partner_go_live"'));
    expect(stmt).toBeDefined();
    const before = await rows<{ partner_id: string; approved_at: string }>(post, `SELECT partner_id, approved_at::text FROM partner_go_live ORDER BY partner_id`);
    await exec(post, `INSERT INTO partners (id, name) VALUES ('gamma', 'Gamma')`);
    await exec(post, stmt!);
    await exec(post, stmt!);
    const after = await rows<{ partner_id: string; approved_at: string }>(post, `SELECT partner_id, approved_at::text FROM partner_go_live ORDER BY partner_id`);
    expect(after.filter((r) => r.partner_id !== 'gamma')).toEqual(before);
    expect(after.map((r) => r.partner_id)).toEqual(['acme', 'beta', 'default', 'gamma']);
  });

  it('after 0028 the staff CHECK accepts finance and the existing staff row is untouched', async () => {
    await staffRow(post, 'post-fin', 'finance');
    expect(await createStaffRepo(post).get('pre-admin')).toMatchObject({ role: 'admin', partnerId: 'acme' });
  });
});
