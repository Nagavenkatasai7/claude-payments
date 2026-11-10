import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { writeComplianceUser, writePosture, type LiveActor } from '@/lib/live-controls-write';

// Fix pack 3 T9 (R27, contracts 9 and 13): the typed live-controls writers for the posture and
// the compliance users. Each write is ONE transaction: the key write under the partner row lock,
// one audit row, one ops alert (ids only) and, when the partner has an alert address and is not
// 'default', one partner email. A refusal writes nothing. T10 extends this file.

let db: Db;
const ACTOR: LiveActor = { username: 'acme-admin', scope: 'partner' };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const POSTURE_IN = { kycDecider: 'smartremit_procedures', holdDecider: 'partner', fourEyesNonSanctions: true } as const;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}
async function column(id = 'acme'): Promise<Record<string, unknown>> {
  const r = await rows<{ live_controls: Record<string, unknown> }>(sql`SELECT live_controls FROM partners WHERE id = ${id}`);
  return r[0].live_controls;
}
const audits = () => rows<{ partner_id: string; actor: string; actor_type: string; action: string; subject_id: string; meta: Record<string, unknown> }>(
  sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`,
);
const outboxRows = () => rows<{ kind: string; payload: Record<string, unknown>; dedupe_key: string }>(sql`SELECT kind, payload, dedupe_key FROM outbox ORDER BY id`);
async function setAddress(id: string): Promise<void> {
  await createPartnerRepo(db).updateSupportConfig(id, (prev) => ({ ...prev, complianceAlertEmail: 'compliance@acme.example' }));
}
async function expectNothingWritten(before: unknown): Promise<void> {
  expect(await column()).toEqual(before);
  expect(await audits()).toEqual([]);
  expect(await outboxRows()).toEqual([]);
}
const posture = (i: Parameters<typeof writePosture>[3] = POSTURE_IN, id = 'acme', actor = ACTOR) => db.transaction((tx) => writePosture(tx, id, actor, i));
const compliance = (username: string, on: boolean, id = 'acme') => db.transaction((tx) => writeComplianceUser(tx, id, ACTOR, { username, on }));

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  await setAddress('acme');
});

describe('writePosture', () => {
  it("on 'ours' with smartremit_procedures: the record, one audit row, one ops alert, one email", async () => {
    const before = Date.now();
    expect(await posture()).toEqual({ ok: true });
    const lc = await column();
    const p = lc.posture as Record<string, unknown>;
    expect(p).toMatchObject({
      version: 1,
      signedBy: 'acme-admin',
      kycDecider: 'smartremit_procedures',
      holdDecider: 'partner',
      requireKycBeforeSend: true,
      fourEyesNonSanctions: true,
    });
    expect(Date.parse(String(p.signedAt))).toBeGreaterThanOrEqual(before - 1000);

    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ partner_id: 'acme', actor: 'acme-admin', actor_type: 'staff', action: 'partner.live.posture.sign', subject_id: 'acme' });
    expect(a[0].meta).toEqual({ version: 1, kycDecider: 'smartremit_procedures', holdDecider: 'partner', fourEyesNonSanctions: true, actorScope: 'partner' });

    const o = await outboxRows();
    expect(o.map((r) => r.kind)).toEqual(['ops.alert', 'email.send']);
    expect(o[0].dedupe_key).toMatch(new RegExp(`^livectl:posture:acme:${UUID}$`));
    expect(o[0].payload).toEqual({ message: 'SmartRemit ops: partner.live.posture.sign on partner acme by partner staff.' });
    expect(o[1].dedupe_key).toMatch(new RegExp(`^livectlmail:posture:acme:${UUID}$`));
    expect(o[1].payload).toEqual({
      to: ['compliance@acme.example'],
      subject: 'SmartRemit: a live control changed for your workspace',
      text: 'Your compliance posture was changed by your team (signed). Details are in your SmartRemit workspace.',
    });
  });

  it("delegated with 'partner' succeeds", async () => {
    await db.execute(sql`UPDATE partners SET kyc_mode = 'delegated' WHERE id = 'acme'`);
    expect(await posture({ ...POSTURE_IN, kycDecider: 'partner' })).toEqual({ ok: true });
    expect((await column()).posture).toMatchObject({ kycDecider: 'partner' });
  });

  it('a mismatch either way -> kyc_decider_mismatch, nothing written', async () => {
    const before = await column();
    expect(await posture({ ...POSTURE_IN, kycDecider: 'partner' })).toEqual({ ok: false, code: 'kyc_decider_mismatch' });
    await expectNothingWritten(before);
    await db.execute(sql`UPDATE partners SET kyc_mode = 'delegated' WHERE id = 'acme'`);
    expect(await posture()).toEqual({ ok: false, code: 'kyc_decider_mismatch' });
    await expectNothingWritten(before);
  });

  it('an unknown partner -> not_found, nothing written', async () => {
    const before = await column();
    expect(await posture(POSTURE_IN, 'nobody')).toEqual({ ok: false, code: 'not_found' });
    await expectNothingWritten(before);
  });

  it('other keys and an unknown future key in the column are kept byte for byte', async () => {
    const seeded = {
      certification: { certifiedAt: new Date(Date.now() - 60_000).toISOString(), certifiedBy: 'ops-admin' },
      complianceUsers: ['acme-comp1'],
      futureKey: { nested: [1, 'two', { three: null }] },
    };
    await db.execute(sql`UPDATE partners SET live_controls = ${JSON.stringify(seeded)}::jsonb WHERE id = 'acme'`);
    const others = async () => (await rows<{ v: string }>(sql`SELECT (live_controls - 'posture')::text AS v FROM partners WHERE id = 'acme'`))[0].v;
    const before = await others();
    expect(await posture()).toEqual({ ok: true });
    expect(await others()).toBe(before);
    expect((await column()).futureKey).toEqual(seeded.futureKey);
  });

  it('re-signing replaces the record', async () => {
    await posture();
    await posture({ ...POSTURE_IN, holdDecider: 'smartremit_delegated', fourEyesNonSanctions: false });
    expect((await column()).posture).toMatchObject({ holdDecider: 'smartremit_delegated', fourEyesNonSanctions: false });
    expect(await audits()).toHaveLength(2);
  });

  it("no address, or partner 'default' -> no email row", async () => {
    await seedPartner(db, 'globex');
    expect(await posture(POSTURE_IN, 'globex')).toEqual({ ok: true });
    expect((await outboxRows()).map((r) => r.kind)).toEqual(['ops.alert']);
    await setAddress('default');
    expect(await posture(POSTURE_IN, 'default')).toEqual({ ok: true });
    expect((await outboxRows()).map((r) => r.kind)).toEqual(['ops.alert', 'ops.alert']);
  });

  it('a platform actor reads as platform staff and SmartRemit', async () => {
    expect(await posture(POSTURE_IN, 'acme', { username: 'ops-admin', scope: 'platform' })).toEqual({ ok: true });
    const o = await outboxRows();
    expect(o[0].payload).toEqual({ message: 'SmartRemit ops: partner.live.posture.sign on partner acme by platform staff.' });
    expect(String(o[1].payload.text)).toBe('Your compliance posture was changed by SmartRemit (signed). Details are in your SmartRemit workspace.');
    expect((await audits())[0].meta.actorScope).toBe('platform');
  });

  it('no username, reason or ref in alert or email payloads', async () => {
    await posture();
    await compliance('acme-comp1', true);
    for (const r of await outboxRows()) {
      const s = JSON.stringify(r.payload);
      expect(s).not.toContain('acme-admin');
      expect(s).not.toContain('acme-comp1');
    }
  });
});

describe('writeComplianceUser', () => {
  it('add, add again (deduped), remove', async () => {
    expect(await compliance('acme-comp1', true)).toEqual({ ok: true });
    expect(await compliance('acme-comp2', true)).toEqual({ ok: true });
    expect(await compliance('acme-comp1', true)).toEqual({ ok: true });
    expect((await column()).complianceUsers).toEqual(['acme-comp1', 'acme-comp2']);
    expect(await compliance('acme-comp1', false)).toEqual({ ok: true });
    expect((await column()).complianceUsers).toEqual(['acme-comp2']);

    const a = await audits();
    expect(a.map((r) => r.action)).toEqual(Array(4).fill('partner.live.compliance_user.set'));
    expect(a[0].meta).toEqual({ target: 'acme-comp1', on: true, actorScope: 'partner' });
    expect(a[3].meta).toEqual({ target: 'acme-comp1', on: false, actorScope: 'partner' });
    const o = await outboxRows();
    expect(o.filter((r) => r.kind === 'ops.alert')).toHaveLength(4);
    expect(o[0].dedupe_key).toMatch(new RegExp(`^livectl:complianceUsers:acme:${UUID}$`));
    expect(o[0].payload).toEqual({ message: 'SmartRemit ops: partner.live.compliance_user.set on partner acme by partner staff.' });
    expect(o[1].dedupe_key).toMatch(new RegExp(`^livectlmail:complianceUsers:acme:${UUID}$`));
    expect(o[1].payload.text).toBe('Your compliance users was changed by your team (compliance user added). Details are in your SmartRemit workspace.');
    expect(o.at(-1)!.payload.text).toBe('Your compliance users was changed by your team (compliance user removed). Details are in your SmartRemit workspace.');
  });

  it("a bad username ('' / 'A B' / 65 chars) -> bad_input, nothing written", async () => {
    const before = await column();
    for (const u of ['', 'A B', 'a'.repeat(65)]) {
      expect(await compliance(u, true)).toEqual({ ok: false, code: 'bad_input' });
      expect(await compliance(u, false)).toEqual({ ok: false, code: 'bad_input' });
    }
    await expectNothingWritten(before);
  });

  it('20 listed + add -> bad_input, no audit, no alert, list unchanged', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `acme-u${i}`);
    await db.execute(sql`UPDATE partners SET live_controls = jsonb_build_object('complianceUsers', ${JSON.stringify(twenty)}::jsonb) WHERE id = 'acme'`);
    const before = await column();
    expect(await compliance('acme-extra', true)).toEqual({ ok: false, code: 'bad_input' });
    await expectNothingWritten(before);
    // An already listed name does not grow the list: it still writes and audits.
    expect(await compliance('acme-u3', true)).toEqual({ ok: true });
    expect((await column()).complianceUsers).toEqual(twenty);
    expect(await audits()).toHaveLength(1);
  });

  it('a malformed stored value (a string) is treated as [] on add', async () => {
    await db.execute(sql`UPDATE partners SET live_controls = jsonb_build_object('complianceUsers', 'oops') WHERE id = 'acme'`);
    expect(await compliance('acme-comp1', true)).toEqual({ ok: true });
    expect((await column()).complianceUsers).toEqual(['acme-comp1']);
  });

  it('an unknown partner -> not_found, nothing written', async () => {
    const before = await column();
    expect(await compliance('acme-comp1', true, 'nobody')).toEqual({ ok: false, code: 'not_found' });
    await expectNothingWritten(before);
  });
});
