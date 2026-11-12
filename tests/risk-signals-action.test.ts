import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createPartnerStore } from '@/lib/partner-store';
import { resolveCorridorRules } from '@/lib/compliance-config';
import { RISK_SIGNALS_OFF } from '@/lib/risk-signals';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Fix pack 6 T23 (R48, P22, P21): the platform risk-signal writer. Order: the site-host guard,
// requirePlatformAdmin, the actor's own two-step (NEED_MFA), the partner (default refused), the
// corridor, the fields, the FORCED step-up ('risk_signal.save', always), then ONE transaction: the
// partner read, the corridor in `countries`, the row-locked corridor write (other keys kept) and the
// `risk_signals.set` audit row. No outbox row. Partners get no writer.

let currentStaff: Staff | null;
let db: Db;
const host = vi.hoisted(() => ({ value: 'smartremit.ai' }));
const mfa = vi.hoisted(() => ({ enrolled: new Set<string>() }));
const gate = vi.hoisted(() => ({ result: null as unknown, calls: [] as Array<{ target: string; opts: unknown }> }));
const auth = vi.hoisted(() => ({ calls: 0 }));
const auditFault = vi.hoisted(() => ({ on: false }));
const logs = vi.hoisted(() => ({ warn: [] as unknown[][] }));
const revalidate = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('@/lib/auth', () => ({
  requirePlatformAdmin: async () => {
    auth.calls++;
    if (!currentStaff) throw new Error('REDIRECT:/login');
    if (currentStaff.role !== 'admin' || currentStaff.partnerId !== undefined) throw new Error('REDIRECT:/admin-dashboard');
    return currentStaff;
  },
  requireScope: async () => {
    throw new Error('requireScope must not gate the risk-signal writer');
  },
}));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => void revalidate.paths.push(p) }));
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => new Headers({ host: host.value }),
}));
vi.mock('@/lib/staff-mfa-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/staff-mfa-store')>()),
  staffMfaEnrolled: async (u: string) => mfa.enrolled.has(u),
}));
vi.mock('@/lib/partner-step-up-gate', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-step-up-gate')>();
  return {
    ...actual,
    gateStaffStepUp: async (...a: Parameters<typeof actual.gateStaffStepUp>) => {
      gate.calls.push({ target: a[2], opts: a[3] });
      return gate.result as Awaited<ReturnType<typeof actual.gateStaffStepUp>>;
    },
  };
});
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const actual = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...actual,
    createAuditRepo: (x: Parameters<typeof actual.createAuditRepo>[0]) => {
      const repo = actual.createAuditRepo(x);
      return {
        ...repo,
        record: async (...a: Parameters<typeof repo.record>) => {
          if (auditFault.on) throw new TypeError('audit insert failed');
          return repo.record(...a);
        },
      };
    },
  };
});
vi.mock('@/lib/log', async (orig) => ({
  ...(await orig<typeof import('@/lib/log')>()),
  logWarn: (...a: unknown[]) => void logs.warn.push(a),
}));

import { setRiskSignalsAction } from '@/app/admin-dashboard/compliance/actions';

const NEED_MFA = 'Turn on two-step verification for your own staff account first.';
const FAILED = 'Something went wrong. Nothing was changed. Please try again.';
const BAD_INPUT = 'Check the fields and try again.';

function staff(over: Partial<Staff> = {}): Staff {
  return {
    username: 'root', name: 'Root', role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x', createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const VALID = { partnerId: 'acme', country: 'US', enabled: 'on', amountUsd: '750', newAccountHours: '48' };

function form(values: Record<string, string> = VALID, hold: string[] = ['first_to_recipient', 'chat_cue']): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  for (const h of hold) fd.append('hold', h);
  return fd;
}

async function stored(id: string): Promise<unknown> {
  const r = await db.execute(sql`SELECT corridor_compliance FROM partners WHERE id = ${id}`);
  return (r.rows[0] as { corridor_compliance: unknown } | undefined)?.corridor_compliance;
}

async function audits() {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
  return r.rows as Array<{ partner_id: string; actor: string; actor_type: string; action: string; subject_id: string; meta: Record<string, unknown> }>;
}

async function setCompliance(id: string, value: unknown) {
  await db.execute(sql`UPDATE partners SET corridor_compliance = ${JSON.stringify(value)}::jsonb WHERE id = ${id}`);
}

const act = (fd: FormData) => setRiskSignalsAction(null, fd);

beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'acme');
  currentStaff = staff();
  host.value = 'smartremit.ai';
  mfa.enrolled = new Set(['root']);
  gate.result = null;
  gate.calls = [];
  auth.calls = 0;
  auditFault.on = false;
  logs.warn = [];
  revalidate.paths = [];
});

describe('setRiskSignalsAction - gating', () => {
  it('unauthenticated throws REDIRECT; nothing stored, no audit', async () => {
    currentStaff = null;
    await expect(act(form())).rejects.toThrow('REDIRECT:/login');
    expect(await stored('acme')).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it('a partner-scoped admin and a platform agent are refused', async () => {
    currentStaff = staff({ partnerId: 'acme' });
    await expect(act(form())).rejects.toThrow('REDIRECT');
    currentStaff = staff({ role: 'agent' });
    await expect(act(form())).rejects.toThrow('REDIRECT');
    expect(await stored('acme')).toBeNull();
    expect(gate.calls).toEqual([]);
  });

  it('a partner-site host is refused with a 404 before requirePlatformAdmin runs', async () => {
    host.value = 'acme.smartremit.ai';
    await expect(act(form())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(auth.calls).toBe(0);
    expect(await stored('acme')).toBeNull();
  });

  it('a platform admin without two-step -> NEED_MFA, the step-up is never called', async () => {
    mfa.enrolled = new Set();
    expect(await act(form())).toEqual({ ok: false, error: NEED_MFA });
    expect(gate.calls).toEqual([]);
    expect(await stored('acme')).toBeNull();
  });

  it('the default tenant is refused with no step-up call and no write', async () => {
    const before = await stored('default');
    const r = await act(form({ ...VALID, partnerId: 'default' }));
    expect(r).toEqual({ ok: false, error: 'The default (demo) tenant never shows risk signals.' });
    expect(gate.calls).toEqual([]);
    expect(await stored('default')).toEqual(before);
    expect(await audits()).toEqual([]);
  });

  it('an unknown partner -> Partner not found after the step-up, nothing written', async () => {
    expect(await act(form({ ...VALID, partnerId: 'nope' }))).toEqual({ ok: false, error: 'Partner not found.' });
    expect(gate.calls).toHaveLength(1);
    expect(await audits()).toEqual([]);
  });

  it('a blank or overlong partner id -> Partner not found before the step-up', async () => {
    expect(await act(form({ ...VALID, partnerId: '  ' }))).toEqual({ ok: false, error: 'Partner not found.' });
    expect(await act(form({ ...VALID, partnerId: 'x'.repeat(101) }))).toEqual({ ok: false, error: 'Partner not found.' });
    expect(gate.calls).toEqual([]);
  });
});

describe('setRiskSignalsAction - validation', () => {
  it('a corridor not served (GB) is refused inside the tx, after the step-up', async () => {
    expect(await act(form({ ...VALID, country: 'GB' }))).toEqual({ ok: false, error: 'Invalid corridor.' });
    expect(gate.calls).toHaveLength(1);
    expect(await stored('acme')).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it.each(['IN', 'us', '', 'US;DROP'])('corridor %j is refused before the step-up', async (country) => {
    expect(await act(form({ ...VALID, country }))).toEqual({ ok: false, error: 'Invalid corridor.' });
    expect(gate.calls).toEqual([]);
    expect(await stored('acme')).toBeNull();
  });

  const bad: Array<[string, Record<string, string>, string[]]> = [
    ['enabled yes', { ...VALID, enabled: 'yes' }, []],
    ['enabled ON', { ...VALID, enabled: 'ON' }, []],
    ['enabled missing', { partnerId: 'acme', country: 'US', amountUsd: '750', newAccountHours: '48' }, []],
    ['amountUsd 0', { ...VALID, amountUsd: '0' }, []],
    ['amountUsd 10001', { ...VALID, amountUsd: '10001' }, []],
    ['amountUsd abc', { ...VALID, amountUsd: 'abc' }, []],
    ['amountUsd empty', { ...VALID, amountUsd: '' }, []],
    ['newAccountHours 0', { ...VALID, newAccountHours: '0' }, []],
    ['newAccountHours 721', { ...VALID, newAccountHours: '721' }, []],
    ['newAccountHours 1.5', { ...VALID, newAccountHours: '1.5' }, []],
    ['newAccountHours empty', { ...VALID, newAccountHours: '' }, []],
    ['hold cluster', VALID, ['cluster']],
    ['hold FIRST_TRANSFER', VALID, ['first_transfer', 'FIRST_TRANSFER']],
  ];
  it.each(bad)('%s -> BAD_INPUT, no step-up, no write', async (_name, values, hold) => {
    expect(await act(form(values, hold))).toEqual({ ok: false, error: BAD_INPUT });
    expect(gate.calls).toEqual([]);
    expect(await stored('acme')).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it('the boundaries 1 / 10000 and 1 / 720 pass', async () => {
    expect(await act(form({ ...VALID, amountUsd: '1', newAccountHours: '1' }))).toEqual({ ok: true });
    expect(await act(form({ ...VALID, amountUsd: '10000', newAccountHours: '720' }))).toEqual({ ok: true });
    const cc = (await stored('acme')) as Record<string, { riskSignals: unknown }>;
    expect(cc.US.riskSignals).toEqual({ enabled: true, amountUsd: 10000, newAccountHours: 720, hold: ['first_to_recipient', 'chat_cue'] });
  });
});

describe('setRiskSignalsAction - step-up', () => {
  it('the step-up is forced: target risk_signal.save, opts { always: true }', async () => {
    await act(form());
    expect(gate.calls).toEqual([{ target: 'risk_signal.save', opts: { always: true } }]);
  });

  it('a StepUpRequired from the gate is returned as is, nothing written', async () => {
    const need = { ok: false, error: 'Enter your code.', code: 'step_up_required', factor: 'totp' };
    gate.result = need;
    expect(await act(form())).toBe(need);
    expect(await stored('acme')).toBeNull();
    expect(await audits()).toEqual([]);
    expect(revalidate.paths).toEqual([]);
  });
});

describe('setRiskSignalsAction - the write', () => {
  it('stores the canonical value and keeps every other key byte-equal', async () => {
    await db.execute(sql`UPDATE partners SET countries = '["US","GB"]'::jsonb WHERE id = 'acme'`);
    const other = {
      US: { amlHolds: true, aml: { count: 7 }, amlHoldRules: ['structuring'] },
      GB: { largeAmountUsd: 900, riskSignals: { enabled: true, amountUsd: 10, newAccountHours: 5, hold: ['chat_cue'] } },
    };
    await setCompliance('acme', other);
    const gbBefore = JSON.stringify(((await stored('acme')) as Record<string, unknown>).GB);
    const r = await act(form(VALID, ['chat_cue', 'first_to_recipient', 'chat_cue']));
    expect(r).toEqual({ ok: true });
    const cc = (await stored('acme')) as Record<string, Record<string, unknown>>;
    expect(cc.US).toEqual({
      ...other.US,
      riskSignals: { enabled: true, amountUsd: 750, newAccountHours: 48, hold: ['first_to_recipient', 'chat_cue'] },
    });
    expect(JSON.stringify(cc.GB)).toBe(gbBefore);
    expect(cc.GB).toEqual(other.GB);
    expect(cc.US.amlHoldRules).toEqual(['structuring']);
  });

  it('cents are kept to two places', async () => {
    expect(await act(form({ ...VALID, amountUsd: '250.505' }))).toEqual({ ok: true });
    const cc = (await stored('acme')) as Record<string, { riskSignals: { amountUsd: number } }>;
    expect(cc.US.riskSignals.amountUsd).toBe(250.51);
  });

  it('one risk_signals.set row with the resolved previous value and the new one', async () => {
    await act(form());
    const rows = await audits();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ partner_id: 'acme', actor: 'root', actor_type: 'staff', action: 'risk_signals.set', subject_id: 'acme' });
    expect(row.meta).toEqual({
      country: 'US',
      from: { enabled: RISK_SIGNALS_OFF.enabled, amountUsd: RISK_SIGNALS_OFF.amountUsd, newAccountHours: RISK_SIGNALS_OFF.newAccountHours, hold: [] },
      to: { enabled: true, amountUsd: 750, newAccountHours: 48, hold: ['first_to_recipient', 'chat_cue'] },
    });
    // Only booleans, numbers and enum strings anywhere in the meta.
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === 'object') return Object.values(v).forEach(walk);
      expect(['boolean', 'number', 'string']).toContain(typeof v);
      if (typeof v === 'string') expect(v).toMatch(/^(US|first_to_recipient|first_transfer|new_account|amount_over_threshold|chat_cue)$/);
    };
    walk(row.meta);
  });

  it('from is the stored previous value through the resolver (garbage never reaches the meta)', async () => {
    await setCompliance('acme', { US: { riskSignals: { enabled: 'yes', amountUsd: -4, newAccountHours: 12, hold: ['chat_cue', 'junk', 'chat_cue'] } } });
    await act(form());
    const [row] = await audits();
    expect(row.meta.from).toEqual({ enabled: false, amountUsd: 500, newAccountHours: 12, hold: ['chat_cue'] });
  });

  it('enabled off stores enabled:false and keeps the posted thresholds and hold list', async () => {
    expect(await act(form({ ...VALID, enabled: 'off' }))).toEqual({ ok: true });
    const cc = (await stored('acme')) as Record<string, { riskSignals: unknown }>;
    expect(cc.US.riskSignals).toEqual({ enabled: false, amountUsd: 750, newAccountHours: 48, hold: ['first_to_recipient', 'chat_cue'] });
    const partner = await createPartnerStore(db).getPartner('acme');
    expect(resolveCorridorRules(partner, 'US').riskSignals.enabled).toBe(false);
  });

  it('the write and the audit commit together: a failed audit rolls the write back', async () => {
    const before = { US: { amlHolds: true } };
    await setCompliance('acme', before);
    auditFault.on = true;
    expect(await act(form())).toEqual({ ok: false, error: FAILED });
    expect(await stored('acme')).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(logs.warn).toEqual([['admin.risk_signals', 'TypeError', { partnerId: 'acme' }]]);
    expect(revalidate.paths).toEqual([]);
  });

  it('no outbox row is written and the page is revalidated on success only', async () => {
    await act(form({ ...VALID, amountUsd: '0' }));
    expect(revalidate.paths).toEqual([]);
    await act(form());
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM outbox`);
    expect((r.rows[0] as { n: number }).n).toBe(0);
    expect(revalidate.paths).toEqual(['/admin-dashboard/compliance']);
  });
});

describe('partners have no risk-signal writer', () => {
  it('no file under src/app/partner names riskSignals', () => {
    const root = join(process.cwd(), 'src/app/partner');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(p, 'utf8').includes('riskSignals')) hits.push(p);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
