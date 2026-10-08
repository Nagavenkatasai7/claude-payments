import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { freshDb, seedLedgerSpend, seedPartner } from './helpers-db';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { createAuditRepo } from '@/db/repos/aux-repos';
import type { Staff } from '@/lib/types';

// A4 — POST /api/copilot/aml-explain. Self-gated like the other copilot
// routes: platform staff only (admin | agent), MFA-pending refused, the shared
// copilot rate limit (fails open; rate-limited ⇒ the deterministic fallback).
// READ-ONLY: it never changes the transfer or the alert and writes no outbox
// row; it writes ONE copilot.aml_explain audit row on both the AI and the
// fallback path.

const PHONE = '15557770042';
let db: Awaited<ReturnType<typeof freshDb>>;
let currentStaff: Staff | null;
const rateLimit = vi.fn(async () => true);
const mfaPending = vi.fn(async () => false);

vi.mock('@/lib/auth', () => ({ getCurrentStaff: async () => currentStaff }));
vi.mock('@/db/client', () => ({ getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => ({}) }));
vi.mock('@/lib/ticket-ai', () => ({ checkCopilotRateLimit: (...a: unknown[]) => rateLimit(...(a as [])) }));
vi.mock('@/lib/partner-mfa-gate', () => ({ inviteMfaPending: (...a: unknown[]) => mfaPending(...(a as [])) }));
vi.mock('@/lib/ollama', () => ({ chat: vi.fn() }));

import { POST } from '@/app/api/copilot/aml-explain/route';
import { chat } from '@/lib/ollama';

const chatMock = vi.mocked(chat);

function staff(over: Partial<Staff> = {}): Staff {
  return {
    username: 'alice',
    name: 'Alice',
    role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function req(body: unknown): NextRequest {
  return new NextRequest('https://smartremit.test/api/copilot/aml-explain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

async function explainAudits() {
  return rows<{ partner_id: string; actor: string; subject_id: string; meta: Record<string, unknown> }>(
    sql`SELECT partner_id, actor, subject_id, meta FROM audit_events WHERE action = 'copilot.aml_explain'`,
  );
}

async function transferRow(id: string) {
  return (await rows<Record<string, unknown>>(sql`SELECT * FROM transfers WHERE id = ${id}`))[0];
}

let alerted = '';
let held = '';
let plain = '';

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  currentStaff = staff();
  rateLimit.mockReset().mockResolvedValue(true);
  mfaPending.mockReset().mockResolvedValue(false);
  chatMock.mockReset();
  // A delivered transfer with an aml.alert row (alert-only eligibility).
  alerted = await seedLedgerSpend(db, { partnerId: 'acme', phone: PHONE, amountUsd: 850, status: 'delivered', createdAt: new Date(Date.now() - 3_600_000) });
  await createAuditRepo(db).record({
    partnerId: 'acme', actor: 'system', actorType: 'system', action: 'aml.alert', subjectId: alerted,
    meta: { rule: 'structuring', window: '7d', count: 3, sumUsd: 2550 },
  });
  // An in_review hold with no alert yet (recompute path).
  held = await seedLedgerSpend(db, { partnerId: 'acme', phone: '15557770043', amountUsd: 900, status: 'in_review', complianceReasons: [AML_HOLD_REASON] });
  // A plain row: neither held nor alerted.
  plain = await seedLedgerSpend(db, { partnerId: 'acme', phone: '15557770044', amountUsd: 20, status: 'delivered' });
});

describe('/api/copilot/aml-explain — gates', () => {
  it('401 with no session', async () => {
    currentStaff = null;
    expect((await POST(req({ subjectId: alerted }))).status).toBe(401);
  });

  it('403 for support and finance', async () => {
    for (const role of ['support', 'finance'] as const) {
      currentStaff = staff({ role });
      expect((await POST(req({ subjectId: alerted }))).status).toBe(403);
    }
    expect(await explainAudits()).toEqual([]);
  });

  it('403 for partner-scoped staff, even an admin', async () => {
    currentStaff = staff({ partnerId: 'acme' });
    expect((await POST(req({ subjectId: alerted }))).status).toBe(403);
  });

  it('403 while invite MFA enrolment is pending', async () => {
    mfaPending.mockResolvedValue(true);
    expect((await POST(req({ subjectId: alerted }))).status).toBe(403);
  });

  it('an agent is allowed', async () => {
    currentStaff = staff({ role: 'agent', username: 'ann' });
    chatMock.mockResolvedValueOnce({ role: 'assistant', content: '{"summary":"s","checks":[],"next_step":"escalate"}' });
    expect((await POST(req({ subjectId: alerted }))).status).toBe(200);
  });

  it('404 for an unknown id, a missing body field and an ineligible transfer (no hold, no alert)', async () => {
    expect((await POST(req({ subjectId: 'tr_nope' }))).status).toBe(404);
    expect((await POST(req({}))).status).toBe(404);
    expect((await POST(req({ subjectId: plain }))).status).toBe(404);
    expect(await explainAudits()).toEqual([]);
    expect(chatMock).not.toHaveBeenCalled();
  });
});

describe('/api/copilot/aml-explain — explanation', () => {
  it('AI path: 200 source "ai" with facts + explanation, and ONE audit row', async () => {
    chatMock.mockResolvedValueOnce({
      role: 'assistant',
      content: JSON.stringify({ summary: 'Three in-band sends.', checks: ['History'], next_step: 'review_sender_history' }),
    });
    const res = await POST(req({ subjectId: alerted }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      source: 'ai',
      facts: { audience: 'platform', rules: [{ rule: 'structuring', count: 3, sumUsd: 2550, source: 'alert' }] },
      explanation: { summary: 'Three in-band sends.', checks: ['History'], next_step: 'review_sender_history' },
    });
    expect(JSON.stringify(body)).not.toContain(PHONE);
    expect(await explainAudits()).toEqual([
      { partner_id: 'acme', actor: 'alice', subject_id: alerted, meta: { source: 'ai', rules: ['structuring'], audience: 'platform' } },
    ]);
  });

  it('chat throws ⇒ 200 source "fallback" + audit', async () => {
    chatMock.mockRejectedValueOnce(new Error('timeout'));
    const res = await POST(req({ subjectId: alerted }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, source: 'fallback', explanation: { next_step: 'review_sender_history' } });
    expect(body.explanation.summary).toContain('several smaller sends');
    expect((await explainAudits())[0].meta).toEqual({ source: 'fallback', rules: ['structuring'], audience: 'platform' });
  });

  it('rate-limited ⇒ the fallback, no model call', async () => {
    rateLimit.mockResolvedValue(false);
    const res = await POST(req({ subjectId: alerted }));
    expect(res.status).toBe(200);
    expect((await res.json()).source).toBe('fallback');
    expect(chatMock).not.toHaveBeenCalled();
    expect(await explainAudits()).toHaveLength(1);
  });

  it('a limiter error fails open (the AI still runs)', async () => {
    rateLimit.mockRejectedValue(new Error('redis down'));
    chatMock.mockResolvedValueOnce({ role: 'assistant', content: '{"summary":"s","checks":[],"next_step":"escalate"}' });
    const res = await POST(req({ subjectId: alerted }));
    expect((await res.json()).source).toBe('ai');
  });

  it('a held row with no alert recomputes the facts (marked "recomputed" when a rule fires)', async () => {
    chatMock.mockRejectedValueOnce(new Error('down'));
    const res = await POST(req({ subjectId: held }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // $900 first-ever send ≥ $500 ⇒ first_transfer
    expect(body.facts.rules).toEqual([
      { rule: 'first_transfer', reason: 'a large first send from a new customer', source: 'recomputed', window: 'first', count: 1, sumUsd: 900 },
    ]);
    expect(body.facts.onHold).toBe(true);
  });

  it('a row held for another reason (no AML hold, no alert) shows no recomputed rule', async () => {
    // Security review: re-running the AML rules on a sanctions/identity hold
    // would name a rule that never held the transfer.
    const other = await seedLedgerSpend(db, { partnerId: 'acme', phone: '15557770045', amountUsd: 900, status: 'in_review', complianceReasons: ['Possible sanctions match.'] });
    chatMock.mockRejectedValueOnce(new Error('down'));
    const res = await POST(req({ subjectId: other }));
    expect(res.status).toBe(200);
    expect((await res.json()).facts.rules).toEqual([]);
  });

  it('a purpose hold (purpose.flag row) skips the AML recompute and reads purpose_hold with the category (security review L1)', async () => {
    // $900 first-ever send would recompute to first_transfer, but the purpose check held it.
    const purposeHeld = await seedLedgerSpend(db, { partnerId: 'acme', phone: '15557770046', amountUsd: 900, status: 'in_review', complianceReasons: [AML_HOLD_REASON] });
    await createAuditRepo(db).record({
      partnerId: 'acme', actor: 'system:purpose-check', actorType: 'system', action: 'purpose.flag', subjectId: purposeHeld,
      meta: { category: 'investment' },
    });
    chatMock.mockRejectedValueOnce(new Error('down'));
    const res = await POST(req({ subjectId: purposeHeld }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.facts.rules).toEqual([]);
    expect(body.facts.holdReasons).toEqual(['purpose_hold']);
    expect(body.facts.purposeRisk).toEqual({ category: 'investment', label: 'Investment or crypto' });
  });

  it('never changes the transfer or the alert, and writes no outbox row', async () => {
    const before = await transferRow(alerted);
    const alertsBefore = await rows(sql`SELECT * FROM audit_events WHERE action = 'aml.alert' ORDER BY id`);
    chatMock.mockResolvedValueOnce({ role: 'assistant', content: '{"summary":"s","checks":[],"next_step":"close_alert_no_action"}' });
    await POST(req({ subjectId: alerted }));
    chatMock.mockRejectedValueOnce(new Error('x'));
    await POST(req({ subjectId: held }));
    expect(await transferRow(alerted)).toEqual(before);
    expect(await rows(sql`SELECT * FROM audit_events WHERE action = 'aml.alert' ORDER BY id`)).toEqual(alertsBefore);
    expect(await rows(sql`SELECT * FROM audit_events WHERE action = 'aml.reviewed'`)).toEqual([]);
    expect(await rows(sql`SELECT id FROM outbox`)).toEqual([]);
  });
});
