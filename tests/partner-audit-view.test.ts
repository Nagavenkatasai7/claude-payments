import { describe, it, expect } from 'vitest';
import {
  projectAuditRow,
  parseAuditFilters,
  parseAuditCursor,
  auditCursorOf,
  actionLabelKey,
  TENANT_AUDIT_ACTIONS,
} from '@/lib/partner-audit-view';
import { t } from '@/lib/i18n';

// UI redesign M3-4: the pure half of the partner audit viewer. The allowlists (actions, meta keys)
// and the projection are what keep platform-internal rows and PII off a tenant's screen.
const tenant = new Set(['pa-admin', 'pa-ops']);
const row = (o: Record<string, unknown>) => ({
  id: 1,
  at: new Date('2026-09-01T10:00:00.000Z'),
  actor: 'pa-admin',
  actorType: 'staff',
  action: 'api_key.issue',
  subjectId: 'k1',
  meta: null,
  ...o,
});
const DAY = 86_400_000;

describe('projectAuditRow', () => {
  it('never renders raw meta; only allowlisted keys per action', () => {
    const p = projectAuditRow(row({ meta: { mode: 'test', last4: 'abcd', plaintext: 'SHOULD_NOT_SHOW' } }), tenant);
    expect(JSON.stringify(p)).not.toContain('SHOULD_NOT_SHOW');
    expect(p.detail).toContain('abcd');
    expect(p.detail).toContain('mode=test');
  });
  it('an action with no meta allowlist shows no detail at all, whatever meta holds', () => {
    const pii = {
      ip: '203.0.113.9',
      old: { phone: '+15550001111', legalName: 'Jane Q Public' },
      new: { email: 'jane@example.com' },
      reason: 'customer +15550001111 asked',
      previousSlug: 'old-brand',
      primaryColor: '#123456',
    };
    for (const action of ['auth.mfa.enroll', 'partner.disclosure_config', 'send_limits.set', 'transfer.release', 'partner.slug.update', 'partner.theme.update']) {
      const p = projectAuditRow(row({ action, meta: pii }), tenant);
      expect(p.detail, action).toBeNull();
      const s = JSON.stringify(p);
      for (const v of ['203.0.113', '5550001111', 'Jane', 'jane@', 'old-brand', '#123456']) expect(s, action).not.toContain(v);
    }
  });
  it('detail values are cut at 40 characters and arrays are joined', () => {
    const p = projectAuditRow(row({ action: 'pii.view', meta: { fields: ['full_name', 'date_of_birth'] } }), tenant);
    expect(p.detail).toBe('fields=full_name date_of_birth');
    const long = projectAuditRow(row({ action: 'report.request', meta: { kind: 'x'.repeat(80) } }), tenant);
    expect(long.detail!.length).toBeLessThanOrEqual('kind='.length + 40);
  });
  it('a detail value that looks like a phone or an email is masked', () => {
    const p = projectAuditRow(row({ action: 'report.request', meta: { kind: '+15550001111' } }), tenant);
    expect(p.detail).not.toMatch(/\d{7,}/);
    const e = projectAuditRow(row({ action: 'report.request', meta: { kind: 'a@b.co' } }), tenant);
    expect(e.detail).not.toContain('a@b.co');
  });
  it('platform, system and api-key actors are masked; a tenant username is shown', () => {
    expect(projectAuditRow(row({}), tenant).actor).toBe('pa-admin');
    expect(projectAuditRow(row({ actor: 'owner-admin' }), tenant).actor).not.toContain('owner-admin');
    expect(projectAuditRow(row({ actor: 'owner-admin' }), tenant).actor).toBe(t('partner.audit.smartremit'));
    expect(projectAuditRow(row({ actorType: 'system', actor: 'worker' }), tenant).actor).toBe(t('partner.audit.system'));
    expect(projectAuditRow(row({ actorType: 'api_key', actor: 'key_123' }), tenant).actor).toBe(t('partner.audit.apiKey'));
    // A system/api-key row whose actor string happens to equal a tenant username is still masked.
    expect(projectAuditRow(row({ actorType: 'system', actor: 'pa-admin' }), tenant).actor).toBe(t('partner.audit.system'));
  });
  it('customer subjects and phone-shaped subjects are masked', () => {
    const c = projectAuditRow(row({ action: 'pii.view', subjectId: 'cust:' + 'a'.repeat(64) }), tenant).subject;
    expect(c).not.toContain('a'.repeat(20));
    expect(c).toContain('aaaaaa');
    expect(projectAuditRow(row({ action: 'send_limits.set', subjectId: '+15551234567' }), tenant).subject).not.toContain('555123');
    expect(projectAuditRow(row({ action: 'send_limits.set', subjectId: '+1 (555) 123-4567' }), tenant).subject).not.toMatch(/555.?123/);
    expect(projectAuditRow(row({ subjectId: 'someone@example.com' }), tenant).subject).not.toContain('someone');
  });
  it('an id subject is shown; a missing subject is empty', () => {
    expect(projectAuditRow(row({ subjectId: 'tx_abc123' }), tenant).subject).toBe('tx_abc123');
    expect(projectAuditRow(row({ subjectId: null }), tenant).subject).toBe('');
  });
  it('the timestamp is ISO', () => {
    expect(projectAuditRow(row({}), tenant).at).toBe('2026-09-01T10:00:00.000Z');
  });
});

describe('TENANT_AUDIT_ACTIONS', () => {
  it('the allowlist excludes screening, KYC decision, login and ops rows', () => {
    for (const a of ['sanctions.screen', 'kyc.manual_override.create', 'auth.login.failed', 'auth.login.success', 'ops.outbox.retry', 'auth.mfa.reset', 'auth.mfa.failed']) {
      expect(TENANT_AUDIT_ACTIONS).not.toContain(a);
    }
  });
  it('holds the plan list, and every action has a label', () => {
    expect(TENANT_AUDIT_ACTIONS).toContain('transfer.release');
    expect(TENANT_AUDIT_ACTIONS).toContain('api_key.issue');
    expect(Object.isFrozen(TENANT_AUDIT_ACTIONS)).toBe(true);
    for (const a of TENANT_AUDIT_ACTIONS) expect(t(actionLabelKey(a)), a).not.toBe(actionLabelKey(a));
  });
});

describe('parseAuditFilters', () => {
  const now = new Date('2026-09-28T12:00:00.000Z');
  it('an actor outside the tenant is dropped; an action outside the allowlist is dropped', () => {
    const f = parseAuditFilters({ actor: 'someone-else', action: 'sanctions.screen' }, ['pa-admin'], now);
    expect(f.actor).toBeUndefined();
    expect(f.actions).toEqual([...TENANT_AUDIT_ACTIONS]);
  });
  it('a tenant actor and an allowlisted action are kept', () => {
    const f = parseAuditFilters({ actor: 'pa-admin', action: 'api_key.issue' }, ['pa-admin'], now);
    expect(f.actor).toBe('pa-admin');
    expect(f.actions).toEqual(['api_key.issue']);
  });
  it('array-valued params use the first value', () => {
    const f = parseAuditFilters({ actor: ['pa-admin', 'x'], action: ['api_key.issue', 'sanctions.screen'] }, ['pa-admin'], now);
    expect(f.actor).toBe('pa-admin');
    expect(f.actions).toEqual(['api_key.issue']);
  });
  it('the window is clamped to 90 days and defaults to 30', () => {
    const f = parseAuditFilters({ from: '2000-01-01' }, [], now);
    expect(now.getTime() - f.from.getTime()).toBeLessThanOrEqual(90 * DAY);
    const d = parseAuditFilters({}, [], now);
    expect(Math.round((now.getTime() - d.from.getTime()) / DAY)).toBe(30);
    expect(d.to.getTime()).toBe(now.getTime());
  });
  it('`to` is the end of that UTC day, never later than now', () => {
    const f = parseAuditFilters({ to: '2026-09-20' }, [], now);
    expect(f.to.toISOString()).toBe('2026-09-20T23:59:59.999Z');
    expect(parseAuditFilters({ to: '2030-01-01' }, [], now).to.getTime()).toBe(now.getTime());
  });
  it('malformed or inverted dates fall back to the default window', () => {
    for (const sp of [{ from: 'nope' }, { from: '2026-13-45' }, { to: '2026-02-30' }, { from: '2026-09-25', to: '2026-09-20' }]) {
      const f = parseAuditFilters(sp, [], now);
      expect(f.from.getTime() <= f.to.getTime(), JSON.stringify(sp)).toBe(true);
      expect(now.getTime() - f.from.getTime()).toBeLessThanOrEqual(90 * DAY);
    }
    const inv = parseAuditFilters({ from: '2026-09-25', to: '2026-09-20' }, [], now);
    expect(Math.round((now.getTime() - inv.from.getTime()) / DAY)).toBe(30);
  });
  it('a from date within the window is the start of that UTC day', () => {
    expect(parseAuditFilters({ from: '2026-09-10' }, [], now).from.toISOString()).toBe('2026-09-10T00:00:00.000Z');
  });
});

describe('the keyset cursor', () => {
  it('round-trips <ms>.<id>', () => {
    const at = new Date('2026-09-01T10:00:00.123Z');
    const c = auditCursorOf({ at, id: 42 });
    expect(c).toBe(`${at.getTime()}.42`);
    expect(parseAuditCursor(c)).toEqual({ at, id: 42 });
  });
  it('anything else is ignored', () => {
    for (const v of [undefined, '', 'abc', '123.4', '1726000000000', '1726000000000.', '1726000000000.-1', '1726000000000.1e3', '1726000000000.99999999999999999999', ['x']]) {
      expect(parseAuditCursor(v as string | string[] | undefined), String(v)).toBeUndefined();
    }
    expect(parseAuditCursor(['1726000000000.5', 'junk'])).toEqual({ at: new Date(1726000000000), id: 5 });
  });
});
