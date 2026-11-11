import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { captureQueries, freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import {
  writeCertification,
  writeComplianceUser,
  writeContract,
  writeOptIn,
  writePosture,
  type LiveActor,
} from '@/lib/live-controls-write';
import { LIVE_READINESS_LINE_IDS, liveReadiness, type LiveReadiness } from '@/lib/live-certification';
import { isLiveCertified } from '@/lib/live-gate';
import type { LiveCapability } from '@/lib/live-controls';
import { certifyPartnerForTest, certifiedLiveControls } from './helpers-live';

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
    // The default tenant never has a posture (review Q1, H1), so its no-email rule is pinned on
    // the compliance-user writer, which shares recordLiveChange.
    await setAddress('default');
    expect(await compliance('acme-comp1', true, 'default')).toEqual({ ok: true });
    expect((await outboxRows()).map((r) => r.kind)).toEqual(['ops.alert', 'ops.alert']);
  });

  // Pack 3 review Q1 (H1): a posture would force verify-before-send on all of SmartRemit's own
  // default-tenant traffic, and nothing can undo it, so the writer refuses 'default' itself.
  it("partner 'default' -> not_found, nothing written", async () => {
    await setAddress('default');
    const before = await column('default');
    expect(await posture(POSTURE_IN, 'default')).toEqual({ ok: false, code: 'not_found' });
    expect(await column('default')).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(await outboxRows()).toEqual([]);
  });

  // Pack 3 review Q1 (G1): the kycMode the decider is checked against is read under the row lock.
  it('the kycMode read is the partners row lock (FOR NO KEY UPDATE), with no plain partners read before it', async () => {
    const stop = captureQueries();
    expect(await posture()).toEqual({ ok: true });
    const qs = stop().map((q) => q.sql.toLowerCase());
    const onPartners = (q: string) => q.startsWith('select') && q.includes('from "partners"');
    const kycRead = qs.findIndex((q) => onPartners(q) && q.includes('"kyc_mode"'));
    expect(kycRead).toBeGreaterThan(-1);
    expect(qs[kycRead]).toContain('for no key update');
    const plainBefore = qs.slice(0, kycRead).filter((q) => onPartners(q) && !q.includes('for no key update'));
    expect(plainBefore).toEqual([]);
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

// ---------------------------------------------------------------------------------------------
// T10 (R15, R13; contracts 9 and 13): contract, certification and opt-in writers (platform actor).

const PLATFORM: LiveActor = { username: 'ops-admin', scope: 'platform' };
const READY: LiveReadiness = { ok: true, lines: LIVE_READINESS_LINE_IDS.map((id) => ({ id, state: 'pass' as const, ok: true })) };
const NOT_READY: LiveReadiness = { ok: false, lines: READY.lines.map((l, i) => (i === 0 ? { ...l, state: 'fail' as const, ok: false } : l)) };
const today = () => new Date().toISOString().slice(0, 10);
const contract = (i: { ref: string; signedOn: string }, id = 'acme') => db.transaction((tx) => writeContract(tx, id, PLATFORM, i));
const certify = (readiness: LiveReadiness = READY, id = 'acme') =>
  db.transaction((tx) => writeCertification(tx, id, PLATFORM, { kind: 'certify', readiness }, 'Every check reviewed today'));
const revoke = (id = 'acme') => db.transaction((tx) => writeCertification(tx, id, PLATFORM, { kind: 'revoke' }, 'Partner asked to pause live money'));
const counsel = (cap: string, counselRef: string | null, id = 'acme') =>
  db.transaction((tx) => writeOptIn(tx, id, PLATFORM, cap as LiveCapability, { kind: 'counsel', counselRef }));
const approval = (cap: string, on: boolean, actor: LiveActor = ACTOR, id = 'acme') =>
  db.transaction((tx) => writeOptIn(tx, id, actor, cap as LiveCapability, { kind: 'approval', on }));
const partner = async (id = 'acme') => (await createPartnerRepo(db).getPartner(id))!;

describe('writeContract', () => {
  it('stores { ref, signedOn, recordedBy, recordedAt }; audit meta { signedOn, hadPrevious }; alert and email name no ref', async () => {
    const before = Date.now();
    expect(await contract({ ref: '  MSA-2026-ACME-01  ', signedOn: today() })).toEqual({ ok: true });
    const c = (await column()).contract as Record<string, unknown>;
    expect(c).toMatchObject({ ref: 'MSA-2026-ACME-01', signedOn: today(), recordedBy: 'ops-admin' });
    expect(Date.parse(String(c.recordedAt))).toBeGreaterThanOrEqual(before - 1000);
    expect(await contract({ ref: 'MSA-2026-ACME-02', signedOn: today() })).toEqual({ ok: true });

    const a = await audits();
    expect(a.map((r) => r.action)).toEqual(['partner.live.contract.record', 'partner.live.contract.record']);
    expect(a[0]).toMatchObject({ partner_id: 'acme', actor: 'ops-admin', actor_type: 'staff', subject_id: 'acme' });
    expect(a[0].meta).toEqual({ signedOn: today(), hadPrevious: false, actorScope: 'platform' });
    expect(a[1].meta).toEqual({ signedOn: today(), hadPrevious: true, actorScope: 'platform' });

    const o = await outboxRows();
    expect(o.map((r) => r.kind)).toEqual(['ops.alert', 'email.send', 'ops.alert', 'email.send']);
    expect(o[0].dedupe_key).toMatch(new RegExp(`^livectl:contract:acme:${UUID}$`));
    expect(o[0].payload).toEqual({ message: 'SmartRemit ops: partner.live.contract.record on partner acme by platform staff.' });
    expect(o[1].dedupe_key).toMatch(new RegExp(`^livectlmail:contract:acme:${UUID}$`));
    expect(o[1].payload.text).toBe('Your live contract record was changed by SmartRemit (recorded). Details are in your SmartRemit workspace.');
    for (const r of [...o.map((x) => x.payload), ...a.map((x) => x.meta)]) expect(JSON.stringify(r)).not.toContain('MSA-2026');
  });

  it("bad input: empty or 201-char ref, '2026-02-30', a non-date -> bad_input, nothing written", async () => {
    const before = await column();
    for (const i of [
      { ref: '', signedOn: today() },
      { ref: '   ', signedOn: today() },
      { ref: 'x'.repeat(201), signedOn: today() },
      { ref: 'MSA-1', signedOn: '2026-02-30' },
      { ref: 'MSA-1', signedOn: 'yesterday' },
      { ref: 'MSA-1', signedOn: `${today()}T00:00:00Z` },
    ]) {
      expect(await contract(i)).toEqual({ ok: false, code: 'bad_input' });
    }
    await expectNothingWritten(before);
  });

  it('a 200-char ref is accepted; an unknown partner -> not_found', async () => {
    expect(await contract({ ref: 'x'.repeat(200), signedOn: today() })).toEqual({ ok: true });
    expect(await contract({ ref: 'MSA-1', signedOn: today() }, 'nobody')).toEqual({ ok: false, code: 'not_found' });
    expect(await audits()).toHaveLength(1);
  });
});

describe('writeCertification', () => {
  it('certify with a readiness whose ok is true -> { certifiedAt, certifiedBy }, audit meta { reason, linesPassed }, isLiveCertified true', async () => {
    const before = Date.now();
    expect(await certify()).toEqual({ ok: true });
    const c = (await column()).certification as Record<string, unknown>;
    expect(Object.keys(c).sort()).toEqual(['certifiedAt', 'certifiedBy']);
    expect(c.certifiedBy).toBe('ops-admin');
    expect(Date.parse(String(c.certifiedAt))).toBeGreaterThanOrEqual(before - 1000);
    expect(isLiveCertified(await partner())).toBe(true);

    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'partner.live.certify', actor: 'ops-admin', subject_id: 'acme' });
    expect(a[0].meta).toEqual({ reason: 'Every check reviewed today', linesPassed: [...LIVE_READINESS_LINE_IDS], actorScope: 'platform' });
    const o = await outboxRows();
    expect(o.map((r) => r.kind)).toEqual(['ops.alert', 'email.send']);
    expect(o[0].dedupe_key).toMatch(new RegExp(`^livectl:certification:acme:${UUID}$`));
    expect(o[0].payload).toEqual({ message: 'SmartRemit ops: partner.live.certify on partner acme by platform staff.' });
    expect(o[1].payload.text).toBe('Your live certification was changed by SmartRemit (certified). Details are in your SmartRemit workspace.');
    for (const r of o) expect(JSON.stringify(r.payload)).not.toContain('Every check');
  });

  it('certify with readiness.ok false -> not_ready, nothing written', async () => {
    const before = await column();
    expect(await certify(NOT_READY)).toEqual({ ok: false, code: 'not_ready' });
    await expectNothingWritten(before);
  });

  it('pack 3 pin: liveReadiness from facts where every built line passes is still not ok, so certify answers not_ready', async () => {
    const users = ['acme-comp1', 'acme-comp2'];
    const p = { id: 'acme', status: 'active' as const, kycMode: 'ours' as const, requireKycBeforeSend: true, liveControls: certifiedLiveControls({ posture: true, complianceUsers: users }) };
    const r = liveReadiness(p, {
      goLiveApproved: true,
      listFitness: 'live',
      ownWhatsapp: true,
      complianceStaff: users.map((username) => ({ username, partnerId: 'acme', role: 'admin' as const, active: true, mfaEnrolled: true })),
    });
    expect(r.lines.filter((l) => l.state !== 'not_built').every((l) => l.ok)).toBe(true);
    expect(r.ok).toBe(false);
    const before = await column();
    expect(await certify(r)).toEqual({ ok: false, code: 'not_ready' });
    await expectNothingWritten(before);
  });

  it('revoke: revokedAt/revokedBy added, certifiedAt kept, isLiveCertified false; audit meta { reason }', async () => {
    expect(await certify()).toEqual({ ok: true });
    const certifiedAt = ((await column()).certification as Record<string, unknown>).certifiedAt;
    // Revoke must land strictly after certifiedAt (isLiveCertified: revokedAt >= certifiedAt).
    await new Promise((r) => setTimeout(r, 5));
    expect(await revoke()).toEqual({ ok: true });
    const c = (await column()).certification as Record<string, unknown>;
    expect(c).toMatchObject({ certifiedAt, certifiedBy: 'ops-admin', revokedBy: 'ops-admin' });
    expect(Date.parse(String(c.revokedAt))).toBeGreaterThanOrEqual(Date.parse(String(certifiedAt)));
    expect(isLiveCertified(await partner())).toBe(false);
    const a = await audits();
    expect(a.map((r) => r.action)).toEqual(['partner.live.certify', 'partner.live.revoke']);
    expect(a[1].meta).toEqual({ reason: 'Partner asked to pause live money', actorScope: 'platform' });
    const o = await outboxRows();
    expect(o.at(-1)!.payload.text).toBe('Your live certification was changed by SmartRemit (revoked). Details are in your SmartRemit workspace.');
    expect(o.at(-2)!.payload).toEqual({ message: 'SmartRemit ops: partner.live.revoke on partner acme by platform staff.' });
  });

  // Pack 3 final check K1: revoke works in every partner state. A suspended partner keeps a
  // standing certification that would come back on reactivation; revoke is the only way out.
  it('revoke a certified partner that is now SUSPENDED -> ok, revokedAt set, partner.live.revoke; reactivated it is not certified', async () => {
    expect(await certify()).toEqual({ ok: true });
    await db.execute(sql`UPDATE partners SET status = 'suspended' WHERE id = 'acme'`);
    await new Promise((r) => setTimeout(r, 5));
    expect(await revoke()).toEqual({ ok: true });
    const c = (await column()).certification as Record<string, unknown>;
    expect(c.revokedAt).toEqual(expect.any(String));
    expect(c.revokedBy).toBe('ops-admin');
    expect((await audits()).map((r) => r.action)).toEqual(['partner.live.certify', 'partner.live.revoke']);
    await db.execute(sql`UPDATE partners SET status = 'active' WHERE id = 'acme'`);
    expect(isLiveCertified(await partner())).toBe(false);
  });

  it('revoke when not certified or already revoked -> not_certified, no audit', async () => {
    const before = await column();
    expect(await revoke()).toEqual({ ok: false, code: 'not_certified' });
    await expectNothingWritten(before);
    await certify();
    await new Promise((r) => setTimeout(r, 5));
    await revoke();
    const afterRevoke = await column();
    const n = { audits: (await audits()).length, outbox: (await outboxRows()).length };
    expect(await revoke()).toEqual({ ok: false, code: 'not_certified' });
    expect(await column()).toEqual(afterRevoke);
    expect((await audits()).length).toBe(n.audits);
    expect((await outboxRows()).length).toBe(n.outbox);
  });

  it('a malformed stored certification reads as not certified for revoke', async () => {
    await db.execute(sql`UPDATE partners SET live_controls = jsonb_build_object('certification', 'oops') WHERE id = 'acme'`);
    const before = await column();
    expect(await revoke()).toEqual({ ok: false, code: 'not_certified' });
    await expectNothingWritten(before);
  });

  it('certify after a revoke -> a fresh record with no revokedAt', async () => {
    await certify();
    await new Promise((r) => setTimeout(r, 5));
    await revoke();
    await new Promise((r) => setTimeout(r, 5));
    expect(await certify()).toEqual({ ok: true });
    const c = (await column()).certification as Record<string, unknown>;
    expect(Object.keys(c).sort()).toEqual(['certifiedAt', 'certifiedBy']);
    expect(isLiveCertified(await partner())).toBe(true);
  });

  // Pack 3 review C4: isLiveCertified counts a revoke only when revokedAt >= certifiedAt, so a
  // stamp from a clock behind the certifying instance (or a certifiedAt in the future) must still win.
  it('revoke of a certification stamped 5 s in the future -> revokedAt after it, isLiveCertified false', async () => {
    const future = new Date(Date.now() + 5_000).toISOString();
    await db.execute(sql`UPDATE partners SET live_controls = jsonb_build_object('certification', jsonb_build_object('certifiedAt', ${future}::text, 'certifiedBy', 'other-admin')) WHERE id = 'acme'`);
    expect(isLiveCertified(await partner())).toBe(true);
    expect(await revoke()).toEqual({ ok: true });
    const c = (await column()).certification as Record<string, unknown>;
    expect(c.certifiedAt).toBe(future);
    expect(Date.parse(String(c.revokedAt))).toBeGreaterThan(Date.parse(future));
    expect(isLiveCertified(await partner())).toBe(false);
  });

  it('certify over a revoke stamped 5 s in the future -> certifiedAt later than that revokedAt, certified', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 5_000).toISOString();
    await db.execute(sql`UPDATE partners SET live_controls = jsonb_build_object('certification', jsonb_build_object('certifiedAt', ${past}::text, 'certifiedBy', 'other-admin', 'revokedAt', ${future}::text, 'revokedBy', 'other-admin')) WHERE id = 'acme'`);
    expect(isLiveCertified(await partner())).toBe(false);
    expect(await certify()).toEqual({ ok: true });
    const c = (await column()).certification as Record<string, unknown>;
    expect(Object.keys(c).sort()).toEqual(['certifiedAt', 'certifiedBy']);
    expect(Date.parse(String(c.certifiedAt))).toBeGreaterThan(Date.parse(future));
    expect(isLiveCertified(await partner())).toBe(true);
  });

  // Review E4: revoke decides on a read taken AFTER the row lock (lockPartner), never before it.
  it('revoke takes the partners row lock before its read of the partner', async () => {
    await certifyPartnerForTest(db, 'acme');
    const stop = captureQueries();
    expect(await revoke()).toEqual({ ok: true });
    const qs = stop().map((q) => q.sql.toLowerCase());
    const onPartners = (q: string) => q.startsWith('select') && q.includes('from "partners"');
    const firstRead = qs.findIndex((q) => onPartners(q) && !q.includes('for no key update'));
    const firstLock = qs.findIndex((q) => onPartners(q) && q.includes('for no key update'));
    expect(firstRead).toBeGreaterThan(-1);
    expect(firstLock).toBeGreaterThan(-1);
    expect(firstLock).toBeLessThan(firstRead);
  });

  it('an unknown partner -> not_found for certify and revoke', async () => {
    expect(await certify(READY, 'nobody')).toEqual({ ok: false, code: 'not_found' });
    expect(await revoke('nobody')).toEqual({ ok: false, code: 'not_found' });
    expect(await audits()).toEqual([]);
  });
});

describe('writeOptIn', () => {
  it('counsel set -> optIns[cap] { counselRef, counselBy, counselAt }; clear removes counsel and approval; other capabilities kept raw', async () => {
    const seeded = { optIns: { usdc: { counselRef: 'old-usdc', futureField: 7 }, weird: 'kept' } };
    await db.execute(sql`UPDATE partners SET live_controls = ${JSON.stringify(seeded)}::jsonb WHERE id = 'acme'`);
    const before = Date.now();
    expect(await counsel('b2b', '  COUNSEL-B2B-7 ')).toEqual({ ok: true });
    let optIns = (await column()).optIns as Record<string, Record<string, unknown>>;
    expect(optIns.b2b).toMatchObject({ counselRef: 'COUNSEL-B2B-7', counselBy: 'ops-admin' });
    expect(Date.parse(String(optIns.b2b.counselAt))).toBeGreaterThanOrEqual(before - 1000);
    expect(optIns.usdc).toEqual(seeded.optIns.usdc);
    expect(optIns.weird).toBe('kept');

    const a = await audits();
    expect(a[0]).toMatchObject({ action: 'partner.live.optin.counsel' });
    expect(a[0].meta).toEqual({ capability: 'b2b', set: true, actorScope: 'platform' });
    let o = await outboxRows();
    expect(o[0].dedupe_key).toMatch(new RegExp(`^livectl:optIns:acme:${UUID}$`));
    expect(o[1].payload.text).toBe('A live feature approval was changed by SmartRemit (counsel review recorded). Details are in your SmartRemit workspace.');

    // A partner approval on b2b (certified partner), then clearing the counsel removes both.
    await certifyPartnerForTest(db, 'acme', { optIns: [] });
    expect(await counsel('b2b', 'COUNSEL-B2B-8')).toEqual({ ok: true });
    expect(await approval('b2b', true)).toEqual({ ok: true });
    expect(await counsel('b2b', null)).toEqual({ ok: true });
    optIns = (await column()).optIns as Record<string, Record<string, unknown>>;
    expect(optIns.b2b).toBeUndefined();
    expect((await audits()).at(-1)!.meta).toEqual({ capability: 'b2b', set: false, actorScope: 'platform' });
    o = await outboxRows();
    expect(o.at(-1)!.payload.text).toBe('A live feature approval was changed by SmartRemit (counsel review cleared). Details are in your SmartRemit workspace.');
    for (const r of [...o.map((x) => x.payload), ...(await audits()).map((x) => x.meta)]) expect(JSON.stringify(r)).not.toContain('COUNSEL');
  });

  it('unknown capability, an empty or 201-char ref -> bad_input, nothing written', async () => {
    const before = await column();
    expect(await counsel('routing', 'C-1')).toEqual({ ok: false, code: 'bad_input' });
    expect(await approval('routing', true)).toEqual({ ok: false, code: 'bad_input' });
    expect(await counsel('b2b', '  ')).toEqual({ ok: false, code: 'bad_input' });
    expect(await counsel('b2b', 'x'.repeat(201))).toEqual({ ok: false, code: 'bad_input' });
    await expectNothingWritten(before);
  });

  // Pack 3 review Q1 (G1): the approval decides on a read taken AFTER the row lock (lockPartner).
  it('approval on takes the partners row lock before its read of the partner', async () => {
    await certifyPartnerForTest(db, 'acme', { optIns: [] });
    expect(await counsel('b2b', 'COUNSEL-B2B-9')).toEqual({ ok: true });
    const stop = captureQueries();
    expect(await approval('b2b', true)).toEqual({ ok: true });
    const qs = stop().map((q) => q.sql.toLowerCase());
    const onPartners = (q: string) => q.startsWith('select') && q.includes('from "partners"');
    const firstRead = qs.findIndex((q) => onPartners(q) && !q.includes('for no key update'));
    const firstLock = qs.findIndex((q) => onPartners(q) && q.includes('for no key update'));
    expect(firstRead).toBeGreaterThan(-1);
    expect(firstLock).toBeGreaterThan(-1);
    expect(firstLock).toBeLessThan(firstRead);
  });

  it('approval: uncertified -> not_certified; no counselRef -> not_ready; nothing written', async () => {
    expect(await counsel('usdc', 'C-USDC')).toEqual({ ok: true });
    let before = await column();
    let n = (await audits()).length;
    expect(await approval('usdc', true)).toEqual({ ok: false, code: 'not_certified' });
    expect(await column()).toEqual(before);
    expect((await audits()).length).toBe(n);

    await certifyPartnerForTest(db, 'acme', { optIns: [] });
    before = await column();
    n = (await audits()).length;
    const outboxN = (await outboxRows()).length;
    expect(await approval('usdc', true)).toEqual({ ok: false, code: 'not_ready' });
    expect(await column()).toEqual(before);
    expect((await audits()).length).toBe(n);
    expect((await outboxRows()).length).toBe(outboxN);
  });

  it("approval on -> partnerApprovedBy/At, audit meta { capability, on }, email 'by your team'; off deletes partnerApproved*", async () => {
    await certifyPartnerForTest(db, 'acme', { optIns: [] });
    expect(await counsel('schedules', 'C-SCHED')).toEqual({ ok: true });
    const before = Date.now();
    expect(await approval('schedules', true)).toEqual({ ok: true });
    let rec = ((await column()).optIns as Record<string, Record<string, unknown>>).schedules;
    expect(rec).toMatchObject({ counselRef: 'C-SCHED', partnerApprovedBy: 'acme-admin' });
    expect(Date.parse(String(rec.partnerApprovedAt))).toBeGreaterThanOrEqual(before - 1000);
    const a = await audits();
    expect(a.at(-1)).toMatchObject({ action: 'partner.live.optin.approve', actor: 'acme-admin' });
    expect(a.at(-1)!.meta).toEqual({ capability: 'schedules', on: true, actorScope: 'partner' });
    let o = await outboxRows();
    expect(o.at(-2)!.payload).toEqual({ message: 'SmartRemit ops: partner.live.optin.approve on partner acme by partner staff.' });
    expect(o.at(-1)!.payload.text).toBe('A live feature approval was changed by your team (approved). Details are in your SmartRemit workspace.');

    expect(await approval('schedules', false)).toEqual({ ok: true });
    rec = ((await column()).optIns as Record<string, Record<string, unknown>>).schedules;
    expect(Object.keys(rec).sort()).toEqual(['counselAt', 'counselBy', 'counselRef']);
    expect((await audits()).at(-1)!.meta).toEqual({ capability: 'schedules', on: false, actorScope: 'partner' });
    o = await outboxRows();
    expect(o.at(-1)!.payload.text).toBe('A live feature approval was changed by your team (approval withdrawn). Details are in your SmartRemit workspace.');
  });

  it('an unknown partner -> not_found', async () => {
    expect(await counsel('b2b', 'C-1', 'nobody')).toEqual({ ok: false, code: 'not_found' });
    expect(await approval('b2b', true, ACTOR, 'nobody')).toEqual({ ok: false, code: 'not_found' });
    expect(await audits()).toEqual([]);
  });
});

describe('T10 writers: emails', () => {
  it("no email for 'default' or a partner with no address; SmartRemit wording otherwise", async () => {
    await seedPartner(db, 'globex');
    expect(await contract({ ref: 'MSA-G', signedOn: today() }, 'globex')).toEqual({ ok: true });
    expect(await counsel('mcp', 'C-G', 'globex')).toEqual({ ok: true });
    expect(await certify(READY, 'globex')).toEqual({ ok: true });
    expect((await outboxRows()).map((r) => r.kind)).toEqual(['ops.alert', 'ops.alert', 'ops.alert']);
    await setAddress('default');
    expect(await contract({ ref: 'MSA-D', signedOn: today() }, 'default')).toEqual({ ok: true });
    expect((await outboxRows()).map((r) => r.kind)).toEqual(['ops.alert', 'ops.alert', 'ops.alert', 'ops.alert']);
    for (const r of await outboxRows()) expect(String(r.payload.message)).toMatch(/^SmartRemit ops: /);
  });
});
