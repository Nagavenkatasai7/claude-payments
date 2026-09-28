import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// UI redesign M3-4: /partner/audit. The page gates itself (admin only, MFA enforced), reads the
// SESSION tenant's rows only, and renders the safe projection (no raw meta, no PII).
const redis = fakeRedis();
const box: { db: Db | null } = { db: null };
let pgPartnerStore: PartnerStore;
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers(),
}));
const redirectMock = vi.hoisted(() =>
  vi.fn((p: string) => {
    throw new Error('REDIRECT:' + p);
  }),
);
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client');
  return { ...actual, getDb: () => box.db };
});
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});

import { getAuthStore } from '@/lib/auth-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { auditEvents } from '@/db/schema';
import AuditPage from '@/app/partner/(app)/audit/page';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const mkStaff = (o: Partial<Staff>): Staff => ({
  username: 'u1',
  name: 'U',
  role: 'admin',
  permissions: perms,
  passwordHash: 'x',
  createdAt: new Date().toISOString(),
  ...o,
});
async function signInAs(o: Partial<Staff>): Promise<void> {
  const s = mkStaff(o);
  await getAuthStore().saveStaff(s);
  cookieJar.set(SESSION_COOKIE, await getAuthStore().createSession(s.username));
}
type SP = Record<string, string | string[] | undefined>;
const open = (sp: SP = {}) => AuditPage({ searchParams: Promise.resolve(sp) });
const render = async (sp: SP = {}) => renderToStaticMarkup(await open(sp));

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
async function audit(o: {
  partnerId: string | null;
  action: string;
  actor?: string;
  actorType?: string;
  subjectId?: string | null;
  meta?: unknown;
  at?: Date;
}): Promise<number> {
  const [r] = await box
    .db!.insert(auditEvents)
    .values({
      partnerId: o.partnerId,
      actor: o.actor ?? 'pa-admin',
      actorType: o.actorType ?? 'staff',
      action: o.action,
      subjectId: o.subjectId ?? null,
      meta: o.meta ?? null,
      at: o.at ?? daysAgo(1),
    })
    .returning({ id: auditEvents.id });
  return r.id;
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
  box.db = await freshDb();
  pgPartnerStore = createPartnerStore(box.db);
  await seedPartner(box.db, 'pa');
  await seedPartner(box.db, 'pb');
  await getAuthStore().saveStaff(mkStaff({ username: 'pa-ops', role: 'agent', partnerId: 'pa' }));
  await getAuthStore().saveStaff(mkStaff({ username: 'pb-admin', role: 'admin', partnerId: 'pb' }));
  await getAuthStore().saveStaff(mkStaff({ username: 'owner-admin', role: 'admin', partnerId: undefined }));
});

describe('/partner/audit: the gate (the page gates itself; MFA enforced)', () => {
  it('anonymous → /login', async () => {
    await expect(open()).rejects.toThrow('REDIRECT:/login');
  });
  it('platform staff → /admin-dashboard', async () => {
    await signInAs({ username: 'plat', partnerId: undefined });
    await expect(open()).rejects.toThrow('REDIRECT:/admin-dashboard');
  });
  it('agent and support → /partner (admin only)', async () => {
    await signInAs({ username: 'pa-agent', partnerId: 'pa', role: 'agent' });
    await expect(open()).rejects.toThrow(/^REDIRECT:\/partner$/);
    await signInAs({ username: 'pa-support', partnerId: 'pa', role: 'support' });
    await expect(open()).rejects.toThrow(/^REDIRECT:\/partner$/);
  });
  it('an admin with MFA enrolment pending is sent to enrolment (no skipMfa here)', async () => {
    await signInAs({ username: 'pa-admin', partnerId: 'pa', role: 'admin' });
    await redis.set(`${MFA_PENDING_PREFIX}pa-admin`, '1');
    await expect(open()).rejects.toThrow('REDIRECT:/partner/security?enroll=1');
  });
});

describe('/partner/audit: tenant isolation and the safe projection', () => {
  beforeEach(async () => {
    await signInAs({ username: 'pa-admin', partnerId: 'pa', role: 'admin' });
  });

  it("an admin of pa sees pa's api_key.issue row and not pb's", async () => {
    await audit({ partnerId: 'pa', action: 'api_key.issue', subjectId: 'key-pa', meta: { keyId: 'key-pa', mode: 'live', last4: 'pa42' } });
    await audit({ partnerId: 'pb', action: 'api_key.issue', actor: 'pb-admin', subjectId: 'key-pb', meta: { keyId: 'key-pb', mode: 'live', last4: 'pb99' } });
    await audit({ partnerId: null, action: 'api_key.issue', actor: 'owner-admin', subjectId: 'key-null', meta: { last4: 'nu11' } });
    const html = await render();
    expect(html).toContain('API key issued');
    expect(html).toContain('pa42');
    expect(html).toContain('key-pa');
    for (const s of ['pb99', 'key-pb', 'pb-admin', 'nu11', 'key-null']) expect(html).not.toContain(s);
  });

  it('non-allowlisted actions never appear, even when asked for by name', async () => {
    await audit({ partnerId: 'pa', action: 'created', subjectId: 'subj-created' });
    await audit({ partnerId: 'pa', action: 'sanctions.screen', actorType: 'system', subjectId: 'SCREEN-SUBJ', meta: { evidence: 'EVIDENCE-NAME' } });
    await audit({ partnerId: 'pa', action: 'auth.login.failed', subjectId: 'LOGIN-SUBJ', meta: { ip: '203.0.113.7' } });
    for (const sp of [{}, { action: 'sanctions.screen' }, { action: 'auth.login.failed' }]) {
      const html = await render(sp);
      expect(html, JSON.stringify(sp)).toContain('subj-created');
      for (const s of ['SCREEN-SUBJ', 'EVIDENCE-NAME', 'LOGIN-SUBJ', '203.0.113', 'sanctions.screen', 'auth.login.failed']) {
        expect(html, JSON.stringify(sp)).not.toContain(s);
      }
    }
  });

  it('rows whose meta and subject hold PII render no phone digits, email, name, IP or reason', async () => {
    await audit({ partnerId: 'pa', action: 'send_limits.set', subjectId: '+15550001111', meta: { scope: 'customer', reason: 'asked by +15550001111', old: null, new: { perTransfer: 1000 } } });
    await audit({ partnerId: 'pa', action: 'partner.disclosure_config', meta: { old: null, new: { phone: '+15550002222', legalName: 'Legal Name Co', email: 'ops@example.com' } } });
    await audit({ partnerId: 'pa', action: 'auth.mfa.enroll', subjectId: 'pa-admin', meta: { ip: '198.51.100.23' } });
    await audit({ partnerId: 'pa', action: 'transfer.release', subjectId: 'tx_abc', meta: { reason: 'Verified Jane Doe by phone', previousStatus: 'in_review' } });
    await audit({ partnerId: 'pa', action: 'pii.view', subjectId: 'cust:' + 'ab'.repeat(32), meta: { fields: ['full_name'] } });
    const html = await render();
    const text = html.replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(/\d{7,}/);
    expect(html).not.toMatch(/555000/);
    for (const s of ['Legal Name Co', 'ops@example.com', '198.51.100', 'Jane Doe', 'asked by', 'ab'.repeat(10)]) expect(html).not.toContain(s);
    expect(html).toContain('Customer abab');
    expect(html).toContain('fields=full_name');
  });

  it('a platform actor is shown as SmartRemit, never by username', async () => {
    await audit({ partnerId: 'pa', action: 'partner.whatsapp_config', actor: 'owner-admin', subjectId: 'pa' });
    const html = await render();
    expect(html).toContain('SmartRemit');
    expect(html).not.toContain('owner-admin');
  });

  it('staff rows keep the writers\' actorScope rule: platform-marked rows never name the actor, partner-marked rows do', async () => {
    // The exact meta the real writers produce (team/actions.ts: 'platform'; partners/actions.ts: scopeOf(actor).kind).
    await audit({ partnerId: 'pa', action: 'created', actor: 'owner-admin', subjectId: 'made-by-platform', meta: { actorScope: 'platform', detail: 'x' } });
    await audit({ partnerId: 'pa', action: 'removed', actor: 'pa-former', subjectId: 'made-by-former', meta: { actorScope: 'partner' } });
    await audit({ partnerId: 'pa', action: 'created', actor: 'legacy@example.com', subjectId: 'made-by-legacy', meta: { actorScope: 'partner' } });
    const html = await render();
    expect(html).toContain('made-by-platform');
    expect(html).not.toContain('owner-admin');
    expect(html).toContain('pa-former');
    expect(html).not.toContain('legacy@example.com');
  });

  it("?actor=<pb's username> is ignored, and the actor select lists only this tenant's staff", async () => {
    await audit({ partnerId: 'pa', action: 'created', actor: 'pa-ops', subjectId: 'x1' });
    await audit({ partnerId: 'pb', action: 'created', actor: 'pb-admin', subjectId: 'x2' });
    const html = await render({ actor: 'pb-admin' });
    expect(html).toContain('x1');
    expect(html).not.toContain('x2');
    expect(html).not.toContain('pb-admin');
    expect(html).not.toContain('owner-admin');
    expect(html).toContain('value="pa-ops"');
  });

  it('?actor=<own staff> and ?action=<allowlisted> filter', async () => {
    await audit({ partnerId: 'pa', action: 'created', actor: 'pa-ops', subjectId: 'by-ops' });
    await audit({ partnerId: 'pa', action: 'created', actor: 'pa-admin', subjectId: 'by-admin' });
    await audit({ partnerId: 'pa', action: 'api_key.revoke', actor: 'pa-ops', subjectId: 'revoked-key' });
    const byOps = await render({ actor: 'pa-ops', action: 'created' });
    expect(byOps).toContain('by-ops');
    expect(byOps).not.toContain('by-admin');
    expect(byOps).not.toContain('revoked-key');
  });

  it('a crafted cursor built from a pb row still returns only pa rows', async () => {
    const pbId = await audit({ partnerId: 'pb', action: 'created', actor: 'pb-admin', subjectId: 'pb-subject', at: daysAgo(1) });
    await audit({ partnerId: 'pa', action: 'created', subjectId: 'pa-subject', at: daysAgo(2) });
    const [pbRow] = await box.db!.select().from(auditEvents).where(eq(auditEvents.id, pbId));
    const html = await render({ before: `${pbRow.at.getTime() + 1}.${pbId + 1}` });
    expect(html).toContain('pa-subject');
    expect(html).not.toContain('pb-subject');
  });

  it('keyset paging: an "Older" link carries the cursor and keeps the filters; a malformed cursor is ignored', async () => {
    for (let i = 0; i < 27; i++) await audit({ partnerId: 'pa', action: 'created', subjectId: `s${i}`, at: new Date(Date.now() - (i + 1) * 60_000) });
    const html = await render({ action: 'created' });
    const m = /href="\/partner\/audit\?([^"]*before=(\d{13})\.(\d+)[^"]*)"/.exec(html);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('action=created');
    expect(html).toContain('>s0<');
    expect(html).not.toContain('>s25<');
    const page2 = await render({ action: 'created', before: `${m![2]}.${m![3]}` });
    expect(page2).toContain('>s25<');
    expect(page2).toContain('>s26<');
    expect(page2).not.toContain('>s0<');
    expect(page2).toContain('href="/partner/audit?action=created"'); // back to newest, filters kept
    const junk = await render({ action: 'created', before: 'drop table' });
    expect(junk).toContain('>s0<');
  });

  it('an empty view shows the empty state; the page has exactly one h1 and a GET filter form', async () => {
    const html = await render();
    expect(html).toContain('No events in this view');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<form[^>]*method="get"/i);
    expect(html).not.toContain('name="before"');
    expect(html).toContain('type="date"');
  });

  it('the page writes nothing (read-only: no audit row for viewing)', async () => {
    await audit({ partnerId: 'pa', action: 'created', subjectId: 'x' });
    const before = (await box.db!.select().from(auditEvents)).length;
    await render();
    expect((await box.db!.select().from(auditEvents)).length).toBe(before);
  });
});
