import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { createPartnerRequestRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { decryptField } from '@/lib/field-crypto';
import { hashApplicationToken } from '@/lib/partner-application-token';
import { inviteResendDedupeKey, buildInviteEmail } from '@/lib/partner-invite-email';
import type { Staff } from '@/lib/types';

// Program-Fix 39: resendApplicationInviteAction — the audited staff resend of
// the partner-application invite. Platform-admin only; refuses a completed
// application and an unconfigured mailer; in ONE transaction it locks the
// request row, re-issues the token (the old link dies), enqueues one SEALED
// email keyed on the new token-hash prefix, and audits. A dedupe miss rolls
// the whole thing back so the stored hash never differs from the emailed link.

let db: Db;
let currentStaff: Staff;
const pokeWorkerMock = vi.fn();
const tokenOverride: { token: string | null } = { token: null };

class RedirectError extends Error {
  constructor(readonly to: string) { super(`NEXT_REDIRECT:${to}`); }
}

vi.mock('@/lib/auth', () => ({
  // The REAL rule (src/lib/auth.ts requirePlatformAdmin): role admin AND no partnerId, else redirect.
  requirePlatformAdmin: async () => {
    if (currentStaff.role !== 'admin' || currentStaff.partnerId !== undefined) throw new RedirectError('/admin-dashboard');
    return currentStaff;
  },
}));
vi.mock('@/db/client', async (orig) => ({ ...((await orig()) as object), getDb: () => db }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new RedirectError(to); },
  notFound: () => { throw new RedirectError('404'); },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: () => pokeWorkerMock() }));
// A switchable fixed token (the rollback test needs a predictable dedupe key).
vi.mock('@/lib/partner-application-token', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-application-token')>();
  return {
    ...real,
    issueApplicationToken: (now?: Date) => {
      if (tokenOverride.token === null) return real.issueApplicationToken(now);
      const r = real.issueApplicationToken(now);
      return { ...r, token: tokenOverride.token, hash: real.hashApplicationToken(tokenOverride.token) };
    },
  };
});

import {
  resendApplicationInviteAction,
  approveApplicationAction,
  rejectApplicationAction,
} from '@/app/admin-dashboard/partner-requests/actions';

const REQ = 'preq_TestReq1';
const ORIGINAL_TOKEN = 'a'.repeat(64);

function staff(overrides: Partial<Staff> = {}): Staff {
  return {
    username: 'root', name: 'Root', role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x', createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function form(id = REQ): FormData {
  const f = new FormData();
  f.set('id', id);
  return f;
}

function configureSmtp(): void {
  vi.stubEnv('SMTP_HOST', 'smtp.example.test');
  vi.stubEnv('SMTP_USER', 'mailer@example.test');
  vi.stubEnv('SMTP_PASS', 'not-a-real-password');
}

async function storedHash(): Promise<string | null> {
  const r = (await db.execute(sql`SELECT application_token_hash FROM partner_requests WHERE id = ${REQ}`)) as unknown as {
    rows: Array<{ application_token_hash: string | null }>;
  };
  return r.rows[0]?.application_token_hash ?? null;
}

type OutRow = { id: number; dedupe_key: string; payload: { to: string[]; subject: string; text: string; sealed?: Record<string, string> } };
async function resendRows(): Promise<OutRow[]> {
  const r = (await db.execute(
    sql`SELECT id, dedupe_key, payload FROM outbox WHERE kind = 'email.send' AND starts_with(dedupe_key, ${`partner_app_invite:${REQ}:r`}) ORDER BY id`,
  )) as unknown as { rows: OutRow[] };
  return r.rows.map((x) => ({ ...x, id: Number(x.id) }));
}

async function auditCount(): Promise<number> {
  const r = (await db.execute(
    sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'partner_application.invite_resent' AND subject_id = ${REQ}`,
  )) as unknown as { rows: Array<{ n: number }> };
  return Number(r.rows[0].n);
}

/** The raw token inside a row's sealed link (decrypted the way the worker does). */
function tokenInRow(row: OutRow): string {
  const link = decryptField(row.payload.sealed!.apply_link);
  return link.slice(link.lastIndexOf('/') + 1);
}

async function resend(): Promise<string> {
  try {
    await resendApplicationInviteAction(form());
  } catch (e) {
    if (e instanceof RedirectError) return e.to;
    throw e;
  }
  throw new Error('expected a redirect');
}

beforeEach(async () => {
  db = await freshDb();
  // freshDb()'s TRUNCATE list predates partner_requests — clear it ourselves.
  await db.execute(sql`TRUNCATE partner_requests, partner_applications RESTART IDENTITY CASCADE`);
  currentStaff = staff();
  tokenOverride.token = null;
  pokeWorkerMock.mockReset();
  vi.stubEnv('SMTP_HOST', '');
  vi.stubEnv('SMTP_USER', '');
  vi.stubEnv('SMTP_PASS', '');
  const repo = createPartnerRequestRepo(db);
  await repo.savePartnerRequest({
    id: REQ, companyName: 'Acme Remit', email: 'partners@acme.test', phone: '+1 555 0100',
    corridors: ['US-IN'], capturedAt: new Date().toISOString(),
  });
  await repo.setApplicationToken(REQ, hashApplicationToken(ORIGINAL_TOKEN), new Date(Date.now() + 86_400_000).toISOString());
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resendApplicationInviteAction', { retry: 0 }, () => {
  it('non-admin refused (agent, and a partner-scoped admin): nothing changes', async () => {
    configureSmtp();
    for (const s of [staff({ role: 'agent' }), staff({ partnerId: 'acme' })]) {
      currentStaff = s;
      await expect(resendApplicationInviteAction(form())).rejects.toThrow('NEXT_REDIRECT:/admin-dashboard');
    }
    expect(await storedHash()).toBe(hashApplicationToken(ORIGINAL_TOKEN));
    expect(await resendRows()).toEqual([]);
    expect(await auditCount()).toBe(0);
  });

  it('completed application refused: token unchanged, no email', async () => {
    configureSmtp();
    await createPartnerRequestRepo(db).markApplicationCompleted(REQ);
    expect(await resend()).toBe(`/admin-dashboard/partner-requests/${REQ}?invite=not_invited`);
    expect(await storedHash()).toBe(hashApplicationToken(ORIGINAL_TOKEN));
    expect(await resendRows()).toEqual([]);
    expect(await auditCount()).toBe(0);
  });

  it('unconfigured email refused, token unchanged', async () => {
    expect(await resend()).toBe(`/admin-dashboard/partner-requests/${REQ}?invite=unconfigured`);
    expect(await storedHash()).toBe(hashApplicationToken(ORIGINAL_TOKEN));
    expect(await resendRows()).toEqual([]);
    expect(await auditCount()).toBe(0);
  });

  it('an unknown or malformed id is refused before any write', async () => {
    configureSmtp();
    await expect(resendApplicationInviteAction(form('preq_nope'))).rejects.toThrow('NEXT_REDIRECT:404');
    await expect(resendApplicationInviteAction(form("x' OR 1=1"))).rejects.toThrow();
    expect(await resendRows()).toEqual([]);
  });

  it('resend re-issues the hash and enqueues one sealed row (the old link dies)', async () => {
    configureSmtp();
    expect(await resend()).toBe(`/admin-dashboard/partner-requests/${REQ}?invite=resent`);

    const rows = await resendRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Sealed: the row never holds the cleartext link.
    expect(JSON.stringify(row.payload)).not.toContain('/partners/apply/');
    expect(row.payload.to).toEqual(['partners@acme.test']);
    expect(row.payload.text).toBe(buildInviteEmail().text);

    const newToken = tokenInRow(row);
    const hash = await storedHash();
    expect(hash).toBe(hashApplicationToken(newToken));
    expect(hash).not.toBe(hashApplicationToken(ORIGINAL_TOKEN));
    expect(row.dedupe_key).toBe(inviteResendDedupeKey(REQ, hash!));
    // The old link no longer resolves.
    expect(await createPartnerRequestRepo(db).getByTokenHash(hashApplicationToken(ORIGINAL_TOKEN))).toBeNull();
    expect(await auditCount()).toBe(1);
    expect(pokeWorkerMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent resend → the stored hash matches the emailed link', async () => {
    // NOTE: PGlite is one connection, so the two transactions serialise here;
    // this proves the end state (the newest row's link is the live one), not
    // the FOR UPDATE lock itself (that is Postgres semantics on Neon).
    configureSmtp();
    const results = await Promise.allSettled([resend(), resend()]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const rows = await resendRows();
    expect(rows).toHaveLength(2);
    const newest = rows[rows.length - 1];
    expect(await storedHash()).toBe(hashApplicationToken(tokenInRow(newest)));
    expect(await auditCount()).toBe(2);
  });

  it('a dedupe collision throws and ROLLS BACK: hash unchanged, no audit row', async () => {
    configureSmtp();
    tokenOverride.token = 'b'.repeat(64);
    const collidingKey = inviteResendDedupeKey(REQ, hashApplicationToken(tokenOverride.token));
    await createOutboxRepo(db).enqueue('email.send', { to: [], subject: 'pre-existing', text: 't' }, { dedupeKey: collidingKey });
    await expect(resendApplicationInviteAction(form())).rejects.toThrow(/collided/);
    expect(await storedHash()).toBe(hashApplicationToken(ORIGINAL_TOKEN));
    expect(await auditCount()).toBe(0);
    expect(pokeWorkerMock).not.toHaveBeenCalled();
  });
});

// Program-Fix 49C (partner-02): the staff decision on a SUBMITTED application.
// Platform admins only; a reason is required; only completed → approved|rejected
// (an 'invited' row has nothing to decide, and a decided row is final); the
// application link's token hash is cleared so no decision can reopen it; one
// audit row per decision; and NO email to anyone (the brief sends none).
describe('approve / reject application (fix 49C)', { retry: 0 }, () => {
  function decisionForm(reason = 'Licensed MT, documents reviewed.', id = REQ): FormData {
    const f = new FormData();
    f.set('id', id);
    f.set('reason', reason);
    return f;
  }
  async function decide(action: (f: FormData) => Promise<void>, f: FormData = decisionForm()): Promise<string> {
    try {
      await action(f);
    } catch (e) {
      if (e instanceof RedirectError) return e.to;
      throw e;
    }
    throw new Error('expected a redirect');
  }
  async function status(): Promise<string> {
    const r = (await db.execute(sql`SELECT application_status FROM partner_requests WHERE id = ${REQ}`)) as unknown as {
      rows: Array<{ application_status: string }>;
    };
    return r.rows[0].application_status;
  }
  async function decisionAudits(): Promise<Array<{ action: string; actor: string; meta: { reason?: string } }>> {
    const r = (await db.execute(
      sql`SELECT action, actor, meta FROM audit_events WHERE starts_with(action, 'partner_application.') AND action <> 'partner_application.invite_resent' AND subject_id = ${REQ} ORDER BY id`,
    )) as unknown as { rows: Array<{ action: string; actor: string; meta: { reason?: string } }> };
    return r.rows;
  }
  async function emailRows(): Promise<number> {
    const r = (await db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE kind = 'email.send'`)) as unknown as {
      rows: Array<{ n: number }>;
    };
    return Number(r.rows[0].n);
  }
  const page = `/admin-dashboard/partner-requests/${REQ}`;

  beforeEach(async () => {
    configureSmtp();
    await createPartnerRequestRepo(db).markApplicationCompleted(REQ);
  });

  it('non-admin refused (agent, support, and a partner-scoped admin): nothing changes', async () => {
    for (const s of [staff({ role: 'agent' }), staff({ role: 'support' }), staff({ partnerId: 'acme' })]) {
      currentStaff = s;
      await expect(approveApplicationAction(decisionForm())).rejects.toThrow('NEXT_REDIRECT:/admin-dashboard');
      await expect(rejectApplicationAction(decisionForm())).rejects.toThrow('NEXT_REDIRECT:/admin-dashboard');
    }
    expect(await status()).toBe('completed');
    expect(await decisionAudits()).toEqual([]);
  });

  it('approve: completed → approved, token hash cleared, one audit row with the reason, no email', async () => {
    expect(await decide(approveApplicationAction)).toBe(`${page}?decision=approved`);
    expect(await status()).toBe('approved');
    expect(await storedHash()).toBeNull();
    expect(await createPartnerRequestRepo(db).getByTokenHash(hashApplicationToken(ORIGINAL_TOKEN))).toBeNull();
    const audits = await decisionAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('partner_application.approve');
    expect(audits[0].actor).toBe('root');
    expect(audits[0].meta.reason).toBe('Licensed MT, documents reviewed.');
    expect(await emailRows()).toBe(0);
    expect(pokeWorkerMock).not.toHaveBeenCalled();
  });

  it('reject: completed → rejected, token hash cleared, audited, no email', async () => {
    expect(await decide(rejectApplicationAction, decisionForm('Out of scope for now.'))).toBe(`${page}?decision=rejected`);
    expect(await status()).toBe('rejected');
    expect(await storedHash()).toBeNull();
    const audits = await decisionAudits();
    expect(audits.map((a) => a.action)).toEqual(['partner_application.reject']);
    expect(await emailRows()).toBe(0);
  });

  it('double-decide refused: the first decision stands, exactly one audit row', async () => {
    await decide(approveApplicationAction);
    expect(await decide(rejectApplicationAction)).toBe(`${page}?decision=not_decidable`);
    expect(await decide(approveApplicationAction)).toBe(`${page}?decision=not_decidable`);
    expect(await status()).toBe('approved');
    expect(await decisionAudits()).toHaveLength(1);
  });

  it('an invited (not yet submitted) application cannot be decided', async () => {
    await db.execute(sql`UPDATE partner_requests SET application_status = 'invited' WHERE id = ${REQ}`);
    expect(await decide(approveApplicationAction)).toBe(`${page}?decision=not_decidable`);
    expect(await status()).toBe('invited');
    expect(await storedHash()).toBe(hashApplicationToken(ORIGINAL_TOKEN));
    expect(await decisionAudits()).toEqual([]);
  });

  it('a blank or whitespace reason is refused before any write', async () => {
    expect(await decide(approveApplicationAction, decisionForm('   '))).toBe(`${page}?decision=reason_required`);
    expect(await status()).toBe('completed');
    expect(await decisionAudits()).toEqual([]);
  });

  it('an unknown or malformed id is refused before any write', async () => {
    await expect(approveApplicationAction(decisionForm('ok', 'preq_nope'))).rejects.toThrow('NEXT_REDIRECT:404');
    await expect(rejectApplicationAction(decisionForm('ok', "x' OR 1=1"))).rejects.toThrow();
    expect(await decisionAudits()).toEqual([]);
  });

  it('resend stays refused after a decision (the invite flow is untouched)', async () => {
    await decide(approveApplicationAction);
    expect(await resend()).toBe(`${page}?invite=not_invited`);
    expect(await storedHash()).toBeNull();
  });
});
