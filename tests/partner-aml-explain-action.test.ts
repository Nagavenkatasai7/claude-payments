import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { expectPartnerActionContract, seedPartnerTransfer, seedTwoTenants, signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';

// A4 — the partner side of the AML "Explain" copilot. Owner decision D5:
// partner admins only, and the partner facts carry the rule label only — no
// count, amount sums, window or thresholds. The transfer is resolved INSIDE the
// session tenant (a foreign id is the same not-found as a missing one) and the
// audit row is written under the session tenant.
const redis = fakeRedis();
const cookieJar = new Map<string, string>();
const host = { value: 'smartremit.ai' };
let db: Db;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host: host.value }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/ollama', () => ({ chat: vi.fn() }));

import { explainAmlAction } from '@/app/partner/(app)/transfers/[id]/explain-actions';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { chat } from '@/lib/ollama';
import { t } from '@/lib/i18n';

const chatMock = vi.mocked(chat);
const form = (id: string) => {
  const fd = new FormData();
  fd.set('id', id);
  return fd;
};
async function seedAlert(partnerId: string, transferId: string): Promise<void> {
  await createAuditRepo(db).record({
    partnerId, actor: 'system', actorType: 'system', action: 'aml.alert', subjectId: transferId,
    meta: { rule: 'structuring', window: '7d', count: 7, sumUsd: 2737 },
  });
}
const explains = async () =>
  ((await db.execute(sql`SELECT partner_id, actor, subject_id, meta FROM audit_events WHERE action = 'copilot.aml_explain' ORDER BY id`)) as unknown as {
    rows: Array<{ partner_id: string; actor: string; subject_id: string; meta: Record<string, unknown> }>;
  }).rows;
const transferRows = async () => ((await db.execute(sql`SELECT * FROM transfers ORDER BY id`)) as unknown as { rows: unknown[] }).rows;

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host.value = 'smartremit.ai';
  chatMock.mockReset();
  chatMock.mockResolvedValue({ role: 'assistant', content: '{"summary":"Several sends.","checks":["History"],"next_step":"keep_on_hold"}' });
  db = await freshDb();
  await seedTwoTenants(db);
  await seedPartnerTransfer(db, { id: 'tr_xA1', partnerId: 'pa', status: 'delivered', amountUsd: 900 });
  await seedAlert('pa', 'tr_xA1');
  await seedPartnerTransfer(db, { id: 'tr_xB1', partnerId: 'pb', status: 'delivered', amountUsd: 900 });
  await seedAlert('pb', 'tr_xB1');
  await seedPartnerTransfer(db, { id: 'tr_xA2', partnerId: 'pa', status: 'in_review', complianceStatus: 'flagged', complianceReasons: [AML_HOLD_REASON] });
  await seedPartnerTransfer(db, { id: 'tr_xA3', partnerId: 'pa', status: 'delivered' }); // ineligible
});

const asAdmin = () => signInAs(redis, cookieJar, { username: 'pa-admin', partnerId: 'pa', role: 'admin' });

describe('explainAmlAction: the shared action contract', () => {
  it('runs checklist items 1-4 (gate, role, foreign transfer, forged tenant fields)', async () => {
    await expectPartnerActionContract({
      db, redis, cookieJar,
      action: explainAmlAction,
      form,
      ownId: 'tr_xA1',
      foreignId: 'tr_xB1',
      allowedRole: 'admin',
      disallowedRole: 'agent',
      snapshot: async () => ({ explains: await explains(), transfers: await transferRows() }),
    });
  });

  it.each(['agent', 'support', 'finance'] as const)('a non-admin role (%s) is refused (D5)', async (role) => {
    await signInAs(redis, cookieJar, { username: `pa-${role}`, partnerId: 'pa', role });
    await expect(explainAmlAction(form('tr_xA1'))).rejects.toThrow('REDIRECT:/partner');
    expect(await explains()).toEqual([]);
  });

  it('refuses on a partner-site host', async () => {
    await asAdmin();
    host.value = 'acme.smartremit.ai';
    await expect(explainAmlAction(form('tr_xA1'))).rejects.toThrow('NOT_FOUND');
  });
});

describe('explainAmlAction: refusals', () => {
  it('a foreign, missing, junk or ineligible id is the SAME not-found, nothing written, no model call', async () => {
    await asAdmin();
    const nf = { ok: false, error: t('partner.common.notFound') };
    for (const id of ['tr_xB1', 'tr_missing', '1 OR 1=1', '', 'tr_xA3']) {
      expect(await explainAmlAction(form(id))).toEqual(nf);
    }
    expect(await explains()).toEqual([]);
    expect(chatMock).not.toHaveBeenCalled();
  });
});

describe('explainAmlAction: success', () => {
  it('returns the D5 partner facts (rule label only) and audits under the SESSION tenant', async () => {
    await asAdmin();
    const r = await explainAmlAction(form('tr_xA1'));
    expect(r).toMatchObject({ ok: true, source: 'ai', explanation: { summary: 'Several sends.', next_step: 'keep_on_hold' } });
    if (!r.ok) throw new Error('unexpected');
    expect(r.facts.audience).toBe('partner');
    expect(r.facts.rules).toEqual([{ rule: 'structuring', reason: 'several smaller sends that add up to a large amount', source: 'alert' }]);
    expect(r.facts.thresholds).toBeUndefined();
    // Neither the response nor the prompt carries the alert's count, sum or window.
    const sent = JSON.stringify(chatMock.mock.calls[0][0]);
    for (const s of [JSON.stringify(r), sent]) {
      expect(s).not.toContain('2737');
      expect(s).not.toContain('2,737');
      expect(s).not.toContain('7d');
    }
    expect(sent).not.toContain('tr_xA1');
    expect(sent).not.toContain('14155550101');
    expect(await explains()).toEqual([
      { partner_id: 'pa', actor: 'pa-admin', subject_id: 'tr_xA1', meta: { source: 'ai', rules: ['structuring'], audience: 'partner' } },
    ]);
  });

  it('a held transfer without an alert is eligible; AI down ⇒ the fallback, still audited', async () => {
    chatMock.mockRejectedValue(new Error('timeout'));
    await asAdmin();
    const before = await transferRows();
    const r = await explainAmlAction(form('tr_xA2'));
    expect(r).toMatchObject({ ok: true, source: 'fallback' });
    expect(await explains()).toHaveLength(1);
    expect(await transferRows()).toEqual(before);
  });
});
