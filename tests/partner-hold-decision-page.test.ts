/**
 * Fix pack 7 T12 (P15 transfer page, P8 display and the view audit): the
 * partner transfer page's hold block for a qualified compliance user of a
 * certified owner: the read-only evidence panel (reviewRecordApplies) and,
 * for a queue partner (holdQueueApplies), one decision dialog per
 * partner-decided open class. Each render that shows the panel writes ONE
 * own-tenant `transfer.screening.view` row. Every other viewer and every
 * uncertified partner sees the page unchanged and no audit row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { seedPartnerTransfer, signInAs } from './helpers-partner-app';
import { certifiedQueuePartner, heldRowFor, seedComplianceUsers } from './helpers-hold';
import type { Db } from '@/db/client';
import type { PartnerStore } from '@/lib/partner-store';
import type { Transfer } from '@/lib/types';

const redis = fakeRedis();
const cookieJar = new Map<string, string>();
let db: Db;
let pgPartnerStore: PartnerStore;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => actual.createStore(redis, db) };
});
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis) };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: (store: Parameters<typeof actual.createCustomerStore>[1]) => actual.createCustomerStore(db, store) };
});
// The note form's request key is random per render; fixed here so two renders compare byte for byte.
vi.mock('@/lib/portal-request-key', async (orig) => ({
  ...(await orig<typeof import('@/lib/portal-request-key')>()),
  newRequestKey: () => 'rk-fixed',
}));
const logWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', async (orig) => ({ ...(await orig<typeof import('@/lib/log')>()), logWarn: logWarnSpy }));
// Forces the T12 block off (reviewRecordApplies false) for the byte-identical comparison.
const scope = vi.hoisted(() => ({ off: false }));
vi.mock('@/lib/partner-decision-scope', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-decision-scope')>();
  return { ...real, reviewRecordApplies: (o: Parameters<typeof real.reviewRecordApplies>[0]) => (scope.off ? false : real.reviewRecordApplies(o)) };
});
// Makes the transfer.screening.view write throw (test 10).
const auditFail = vi.hoisted(() => ({ on: false }));
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createAuditRepo: (...a: Parameters<typeof real.createAuditRepo>) => {
      const repo = real.createAuditRepo(...a);
      return {
        ...repo,
        record: async (e: Parameters<typeof repo.record>[0]) => {
          if (auditFail.on && e.action === 'transfer.screening.view') {
            const err = new Error('insert failed: secret detail 15551239876');
            err.name = 'NeonDbError';
            throw err;
          }
          return repo.record(e);
        },
      };
    },
  };
});

import DetailPage from '@/app/partner/(app)/transfers/[id]/page';
import { createPartnerStore } from '@/lib/partner-store';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createHoldReviewRepo } from '@/db/repos/hold-review-repo';
import { auditEvents } from '@/db/schema';
import { staffMfaKeys } from '@/lib/staff-mfa-store';
import { sanctionsAuditEvent, type ScreeningEvidence } from '@/lib/sanctions/evidence';
import { allowedDispositions, classReasonsFp, rowReasonsFp, type HoldDisposition } from '@/lib/hold-queue';
import { AML_HOLD_REASON, LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON } from '@/lib/compliance-config';
import { PURPOSE_RISK_LABELS } from '@/lib/purpose-detail';
import { t as tr } from '@/lib/i18n';

const detail = async (id: string) => renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
const enroll = (u: string) => redis.set(staffMfaKeys.secret(u), 'sealed');
const asUser = (username: string, role: 'admin' | 'agent' | 'finance' | 'support' = 'admin', partnerId = 'acme') =>
  signInAs(redis, cookieJar, { username, partnerId, role });

type Rows<T> = { rows: T[] };
const q = async <T>(s: ReturnType<typeof sql>): Promise<T[]> => ((await db.execute(s)) as unknown as Rows<T>).rows;
const views = () =>
  q<{ partner_id: string; actor: string; actor_type: string; subject_id: string; meta: Record<string, unknown> }>(
    sql`SELECT partner_id, actor, actor_type, subject_id, meta FROM audit_events WHERE action = 'transfer.screening.view' ORDER BY id`,
  );
const html = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** The evidence panel's own HTML (it holds no nested section). */
function panelOf(markup: string): string {
  const i = markup.indexOf('data-testid="partner-hold-evidence"');
  if (i < 0) return '';
  return markup.slice(i, markup.indexOf('</section>', i));
}
const dialogCount = (m: string) => m.split('data-testid="partner-hold-decision"').length - 1;
/** The HTML of the dialog for one class ('' when absent). */
function dialogOf(markup: string, cls: string): string {
  const i = markup.indexOf(`data-testid="partner-hold-decision" data-class="${cls}"`);
  if (i < 0) return '';
  const next = markup.indexOf('data-testid="partner-hold-decision', i + 10);
  return markup.slice(i, next < 0 ? undefined : next);
}
const radios = (m: string) => [...m.matchAll(/<input type="radio"[^>]*name="disposition" value="([a-z_]+)"/g)].map((x) => x[1]);
async function setReasons(id: string, reasons: string[]): Promise<void> {
  await db.execute(sql`UPDATE transfers SET compliance_reasons = ${JSON.stringify(reasons)}::jsonb WHERE id = ${id}`);
}
async function systemAudit(pid: string, id: string, action: string, meta: Record<string, unknown>) {
  await createAuditRepo(db).record({ partnerId: pid, actor: 'system:test', actorType: 'system', action, subjectId: id, meta });
}

const H1 = 'b'.repeat(64);
const H2 = 'c'.repeat(64);
function matchEvidence(): ScreeningEvidence {
  return {
    listSource: 'ofac-sdn',
    listVersion: 'v-2026-test',
    listHash: 'a'.repeat(64),
    screenedAt: new Date(Date.now() - 60_000).toISOString(),
    decision: 'possible_match',
    parties: [
      { role: 'recipient', inputHash: H1, matched: true, matchScore: 0.91, matchedEntryId: 'sdn:12345' },
      { role: 'sender', inputHash: H2, matched: false, matchScore: 0.2 },
    ],
    listFitness: 'live',
    listCheckedAt: new Date(Date.now() - 3_600_000).toISOString(),
    listBaseHash: 'd'.repeat(64),
  };
}
async function seedMatchEvidence(pid: string, id: string): Promise<ScreeningEvidence> {
  const ev = matchEvidence();
  const row = sanctionsAuditEvent(pid, id, ev);
  await db.insert(auditEvents).values({
    partnerId: row.partnerId ?? null, actor: row.actor, actorType: row.actorType, action: row.action,
    subjectId: row.subjectId ?? null, meta: row.meta ?? null, at: new Date(Date.now() + 5),
  });
  return ev;
}

/** A queue partner 'acme' with its two listed compliance admins (MFA enrolled). */
async function queuePartner(o: Parameters<typeof certifiedQueuePartner>[1] = {}): Promise<string> {
  const pid = await certifiedQueuePartner(db, o);
  await seedComplianceUsers(db, pid, ['co-a', 'co-b'], { redis, role: 'admin' });
  return pid;
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  scope.off = false;
  auditFail.on = false;
  logWarnSpy.mockReset();
  db = await freshDb();
  pgPartnerStore = createPartnerStore(db);
});

describe('uncertified partner (every partner today)', () => {
  it('delegated partner, admin, a held LARGE row: no panel, no dialog, the reasons list stays, NO audit row; byte-identical with the block forced off', async () => {
    await seedPartner(db, 'pa');
    await db.execute(sql`UPDATE partners SET kyc_mode = 'delegated' WHERE id = 'pa'`);
    await seedPartnerTransfer(db, {
      id: 'tr_A_held', partnerId: 'pa', status: 'in_review', complianceStatus: 'flagged', complianceReasons: [LARGE_AMOUNT_REASON],
    });
    await asUser('pa-admin', 'admin', 'pa');
    await enroll('pa-admin');
    const on = await detail('tr_A_held');
    expect(on).toContain('data-testid="partner-hold-reasons"');
    expect(on).not.toContain('partner-hold-evidence');
    expect(on).not.toContain('partner-hold-decision');
    expect(await views()).toEqual([]);
    scope.off = true;
    const off = await detail('tr_A_held');
    expect(on).toBe(off);
  });
});

describe('queue partner, qualified compliance user', () => {
  it('kyc row with possible-match evidence: the panel shows list, version, screenedAt, decision and per party role, matched, score, entry; ONE transfer.screening.view row', async () => {
    const pid = await queuePartner();
    const row = await heldRowFor(db, pid, 'kyc');
    const ev = await seedMatchEvidence(pid, row.id);
    await asUser('co-a');
    const m = await detail(row.id);
    const panel = panelOf(m);
    expect(panel).not.toBe('');
    expect(panel).toContain('ofac-sdn');
    expect(panel).toContain('v-2026-test');
    expect(panel).toContain(`dateTime="${ev.screenedAt}"`);
    expect(panel).toContain('possible_match');
    expect(panel).toContain(tr('partner.evidence.role.recipient'));
    expect(panel).toContain(tr('partner.evidence.role.sender'));
    expect(panel).toContain(tr('partner.evidence.matchedYes'));
    expect(panel).toContain('0.91');
    expect(panel).toContain('sdn:12345');
    const v = await views();
    expect(v).toHaveLength(1);
    expect(v[0]).toEqual({
      partner_id: pid, actor: 'co-a', actor_type: 'staff', subject_id: row.id, meta: { holdClasses: ['kyc'], actorScope: 'partner' },
    });
  });

  it('the panel never contains inputHash, listHash, listBaseHash, the sender or recipient name, a phone or the amount', async () => {
    const pid = await queuePartner();
    const row = await heldRowFor(db, pid, 'kyc');
    await seedMatchEvidence(pid, row.id);
    await asUser('co-a');
    const panel = panelOf(await detail(row.id));
    expect(panel).not.toBe('');
    for (const s of [H1, H2, 'a'.repeat(64), 'd'.repeat(64), row.recipientName, 'Test Recipient', 'Test Sender Placeholder', row.phone, row.phone.slice(-4), '$', 'USD']) {
      expect(panel, s).not.toContain(s);
    }
    expect(panel).not.toMatch(/inputHash|listHash|listBaseHash/);
  });

  it('AML sub-kinds: aml.hold -> the rule labels; purpose.flag -> the closed scam label (never the customer text); risk.signals -> the signal labels; no audit row -> the generic AML label', async () => {
    const pid = await queuePartner();
    const a = await heldRowFor(db, pid, 'aml', { id: 'held_aml_rows' });
    await systemAudit(pid, a.id, 'aml.hold', { rules: ['structuring', 'check_failed'] });
    await systemAudit(pid, a.id, 'purpose.flag', { category: 'romance', text: 'my online friend asked me' });
    await systemAudit(pid, a.id, 'risk.signals', { held: ['first_to_recipient'], shown: ['chat_cue'] });
    const b = await heldRowFor(db, pid, 'aml', { id: 'held_aml_none' });
    await asUser('co-a');
    const pa = panelOf(await detail(a.id));
    expect(pa).toContain(tr('partner.reviews.aml.rule.structuring'));
    expect(pa).toContain(tr('partner.evidence.aml.aml_check_failed'));
    expect(pa).toContain(PURPOSE_RISK_LABELS.romance);
    expect(pa).not.toContain('my online friend');
    expect(pa).toContain(tr('partner.evidence.signal.first_to_recipient'));
    expect(pa).not.toContain(tr('partner.evidence.signal.chat_cue'));
    expect(pa).not.toContain(html(tr('partner.transfers.reason.additional')));
    const pb = panelOf(await detail(b.id));
    expect(pb).toContain(html(tr('partner.transfers.reason.additional')));
    expect(pb).not.toContain(tr('partner.evidence.aml.aml_rule'));
  });

  it('one dialog per partner-decided open class with exactly allowedDispositions(class, partner) and rowFp = rowReasonsFp; a sanctions_review class gets NO dialog and the "SmartRemit decides" line', async () => {
    const pid = await queuePartner();
    const row = await heldRowFor(db, pid, 'kyc');
    await setReasons(row.id, [LARGE_AMOUNT_REASON, AML_HOLD_REASON, POSSIBLE_MATCH_REASON]);
    await asUser('co-a');
    const m = await detail(row.id);
    expect(dialogCount(m)).toBe(2);
    for (const c of ['kyc', 'aml'] as const) {
      const d = dialogOf(m, c);
      expect(d, c).not.toBe('');
      const want = [...allowedDispositions(c, 'partner').release, ...allowedDispositions(c, 'partner').reject];
      expect(radios(d).sort()).toEqual([...want].sort());
      expect(d).toContain(`type="hidden" name="rowFp" value="${html(rowReasonsFp([LARGE_AMOUNT_REASON, AML_HOLD_REASON, POSSIBLE_MATCH_REASON]))}"`);
      expect(d).toContain(`type="hidden" name="holdClass" value="${c}"`);
      expect(d).not.toContain('name="screeningFlaggedAt"');
    }
    expect(dialogOf(m, 'sanctions_review')).toBe('');
    expect(m).toContain(`data-testid="partner-hold-decision-note" data-class="sanctions_review"`);
    expect(m).toContain(tr('partner.holdDecision.notYours'));
    expect((await views())[0].meta).toEqual({ holdClasses: ['kyc', 'aml', 'sanctions_review'], actorScope: 'partner' });
  });

  it('fourEyes: a step-1 row by this viewer -> no form, the "another person must approve" note; by another user -> the form, labelled second review; a final row under the current fingerprint -> closed, no form', async () => {
    const pid = await queuePartner({ fourEyes: true });
    const row = await heldRowFor(db, pid, 'kyc');
    const fp = classReasonsFp({ holdClass: 'kyc', reasons: [LARGE_AMOUNT_REASON] });
    const repo = createHoldReviewRepo(db);
    await repo.insert({
      transferId: row.id, partnerId: pid, holdClass: 'kyc', reasonsFp: fp, step: 1, final: false,
      disposition: 'documents_verified', reason: 'Checked the documents on file.', evidence: {}, actor: 'co-a', actorScope: 'partner',
    });
    await asUser('co-a');
    const mine = await detail(row.id);
    expect(dialogCount(mine)).toBe(0);
    expect(mine).toContain(`data-testid="partner-hold-decision-note" data-class="kyc"`);
    expect(mine).toContain(tr('partner.holdDecision.fourEyesNote'));
    await asUser('co-b');
    const other = await detail(row.id);
    const d = dialogOf(other, 'kyc');
    expect(d).not.toBe('');
    expect(d).toContain(tr('partner.holdDecision.secondReview'));
    expect(d).not.toContain(tr('partner.holdDecision.fourEyesNote'));
    await repo.insert({
      transferId: row.id, partnerId: pid, holdClass: 'kyc', reasonsFp: fp, step: 2, final: true,
      disposition: 'documents_verified' as HoldDisposition, reason: 'Second look at the documents.', evidence: {}, actor: 'co-b', actorScope: 'partner',
    });
    const closed = await detail(row.id);
    expect(dialogCount(closed)).toBe(0);
    expect(closed).toContain(tr('partner.holdDecision.closed'));
  });

  it('fourEyes, no review yet: the first-step form shows the four-eyes note beside the release options', async () => {
    const pid = await queuePartner({ fourEyes: true });
    const row = await heldRowFor(db, pid, 'kyc');
    await asUser('co-a');
    const d = dialogOf(await detail(row.id), 'kyc');
    expect(d).toContain(tr('partner.holdDecision.fourEyesNote'));
    expect(d).not.toContain(tr('partner.holdDecision.secondReview'));
  });

  it('sender_pep (partner decides KYC): the dialog carries the hidden screeningFlaggedAt of the sender read', async () => {
    const pid = await queuePartner();
    const row = await heldRowFor(db, pid, 'sender_pep');
    const [c] = await q<{ at: string }>(sql`SELECT screening_flagged_at AS at FROM customers WHERE partner_id = ${pid} AND phone = ${row.phone}`);
    const iso = new Date(c.at).toISOString();
    await asUser('co-a');
    const d = dialogOf(await detail(row.id), 'sender_pep');
    expect(d).not.toBe('');
    expect(d).toContain(`type="hidden" name="screeningFlaggedAt" value="${iso}"`);
  });

  it('a [LARGE] row with a later watchlist stamp: the kyc dialog only (the sender_watchlist class is SmartRemit\'s)', async () => {
    const pid = await queuePartner();
    const row = await heldRowFor(db, pid, 'kyc');
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = now() - interval '1 minute'
      WHERE partner_id = ${pid} AND phone = ${row.phone}`);
    await asUser('co-a');
    const m = await detail(row.id);
    expect(dialogCount(m)).toBe(1);
    expect(dialogOf(m, 'kyc')).not.toBe('');
    expect(m).toContain(`data-testid="partner-hold-decision-note" data-class="sender_watchlist"`);
  });

  it('a sandbox held row on a queue partner: no dialog', async () => {
    const pid = await queuePartner();
    const row = await heldRowFor(db, pid, 'kyc');
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${row.id}`);
    await asUser('co-a');
    const m = await detail(row.id);
    expect(dialogCount(m)).toBe(0);
  });
});

describe('certified, smartremit_delegated partner', () => {
  it('qualified user: the evidence panel, NO dialog', async () => {
    const pid = await queuePartner({ holdDecider: 'smartremit_delegated' });
    const row = await heldRowFor(db, pid, 'kyc');
    await asUser('co-a');
    const m = await detail(row.id);
    expect(panelOf(m)).not.toBe('');
    expect(dialogCount(m)).toBe(0);
    expect(await views()).toHaveLength(1);
  });
});

describe('not qualified: no panel, no dialog, no audit row', () => {
  let row: Transfer;
  beforeEach(async () => {
    const pid = await queuePartner();
    row = await heldRowFor(db, pid, 'kyc');
  });
  const expectNothing = async () => {
    const m = await detail(row.id);
    expect(m).toContain('data-testid="partner-hold-reasons"');
    expect(m).not.toContain('partner-hold-evidence');
    expect(m).not.toContain('partner-hold-decision');
    expect(await views()).toEqual([]);
  };
  it('an admin who is not listed', async () => {
    await asUser('acme-admin');
    await enroll('acme-admin');
    await expectNothing();
  });
  it('a listed agent without MFA', async () => {
    await redis.del(staffMfaKeys.secret('co-a'));
    await asUser('co-a', 'agent');
    await expectNothing();
  });
  it('a listed user in the finance role', async () => {
    await asUser('co-a', 'finance');
    await expectNothing();
  });
  it('support is redirected', async () => {
    await asUser('co-a', 'support');
    await expect(detail(row.id)).rejects.toThrow(/^REDIRECT:/);
    expect(await views()).toEqual([]);
  });
});

describe('the view audit write fails', () => {
  it('no panel (no evidence without its record), the page still renders, one logWarn with the error name only', async () => {
    const pid = await queuePartner();
    const row = await heldRowFor(db, pid, 'kyc');
    await seedMatchEvidence(pid, row.id);
    auditFail.on = true;
    await asUser('co-a');
    const m = await detail(row.id);
    expect(m).toContain('data-testid="partner-hold-reasons"');
    expect(m).not.toContain('partner-hold-evidence');
    expect(await views()).toEqual([]);
    const calls = logWarnSpy.mock.calls.filter((c) => c[0] === 'partner.screening-view');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['partner.screening-view', 'NeonDbError', { transferId: row.id }]);
    expect(JSON.stringify(logWarnSpy.mock.calls)).not.toContain('15551239876');
  });
});
