import { describe, it, expect } from 'vitest';
import {
  projectAuditRow,
  parseAuditFilters,
  parseAuditCursor,
  auditCursorOf,
  actionLabelKey,
  TENANT_AUDIT_ACTIONS,
  TENANT_OWN_ONLY_ACTIONS,
} from '@/lib/partner-audit-view';
import { t } from '@/lib/i18n';

// UI redesign M3-4: the pure half of the partner audit viewer. The allowlists (actions, meta keys)
// and the projection are what keep platform-internal rows and PII off a tenant's screen.
const tenant = new Set(['pa-admin', 'pa-ops']);
const platform = new Set(['owner-admin']);
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
    for (const action of ['auth.mfa.enroll', 'partner.disclosure_config', 'send_limits.set', 'transfer.release', 'partner.slug.update', 'partner.theme.update', 'partner.display_name.update', 'partner.alert_email.update']) {
      const p = projectAuditRow(row({ action, meta: pii }), tenant);
      expect(p.detail, action).toBeNull();
      const s = JSON.stringify(p);
      for (const v of ['203.0.113', '5550001111', 'Jane', 'jane@', 'old-brand', '#123456']) expect(s, action).not.toContain(v);
    }
  });
  it('webhook.replay (M3-15b) shows the replayed outbox id only; actorScope and anything else is dropped', () => {
    const p = projectAuditRow(row({ action: 'webhook.replay', subjectId: '42', meta: { outboxId: 42, actorScope: 'partner', lastError: 'rejected for +15550001111' } }), tenant);
    expect(p.detail).toBe('outboxId=42');
    expect(JSON.stringify(p)).not.toContain('5550001111');
  });
  it('detail values are cut at 80 characters and arrays are joined', () => {
    const p = projectAuditRow(row({ action: 'pii.view', meta: { fields: ['full_name', 'date_of_birth'] } }), tenant);
    expect(p.detail).toBe('fields=full_name date_of_birth');
    const long = projectAuditRow(row({ action: 'report.request', meta: { kind: 'x'.repeat(80) } }), tenant);
    expect(long.detail!.length).toBeLessThanOrEqual('kind='.length + 80 + 1); // + the ellipsis
  });
  it('a detail value that looks like a phone or an email is masked', () => {
    const p = projectAuditRow(row({ action: 'report.request', meta: { kind: '+15550001111' } }), tenant);
    expect(p.detail).not.toMatch(/\d{7,}/);
    const e = projectAuditRow(row({ action: 'report.request', meta: { kind: 'a@b.co' } }), tenant);
    expect(e.detail).not.toContain('a@b.co');
  });
  it('platform, system and api-key actors are masked; a tenant username is shown', () => {
    expect(projectAuditRow(row({}), tenant).actor).toBe('pa-admin');
    expect(projectAuditRow(row({ actor: 'owner-admin' }), tenant, platform).actor).not.toContain('owner-admin');
    expect(projectAuditRow(row({ actor: 'owner-admin' }), tenant, platform).actor).toBe(t('partner.audit.smartremit'));
    expect(projectAuditRow(row({ actorType: 'system', actor: 'worker' }), tenant).actor).toBe(t('partner.audit.system'));
    expect(projectAuditRow(row({ actorType: 'api_key', actor: 'key_123' }), tenant).actor).toBe(t('partner.audit.apiKey'));
    // A system/api-key row whose actor string happens to equal a tenant username is still masked.
    expect(projectAuditRow(row({ actorType: 'system', actor: 'pa-admin' }), tenant).actor).toBe(t('partner.audit.system'));
  });
  it('the actorScope marker refines the rule: a former partner member keeps their name; a platform-marked row never shows one', () => {
    expect(projectAuditRow(row({ actor: 'pa-former', meta: { actorScope: 'partner' } }), tenant).actor).toBe('pa-former');
    expect(projectAuditRow(row({ actor: 'pa-admin', meta: { actorScope: 'platform' } }), tenant).actor).toBe(t('partner.audit.smartremit'));
    expect(projectAuditRow(row({ actor: 'owner-admin', meta: { actorScope: 'bogus' } }), tenant, platform).actor).toBe(t('partner.audit.smartremit'));
    expect(projectAuditRow(row({ actorType: 'system', actor: 'x', meta: { actorScope: 'partner' } }), tenant).actor).toBe(t('partner.audit.system'));
  });
  it('an unmarked row by someone who is neither a current member nor a platform account is "Former staff", never "SmartRemit"', () => {
    // Most staff writers (pii.reveal, pii.view, api_key.*, whatsapp config…) write no actorScope marker.
    const gone = projectAuditRow(row({ action: 'pii.reveal', actor: 'pa-offboarded' }), tenant, platform).actor;
    expect(gone).toBe(t('partner.audit.formerStaff'));
    expect(gone).not.toBe(t('partner.audit.smartremit'));
    expect(gone).not.toContain('pa-offboarded');
    // A current platform account on an unmarked row is still SmartRemit.
    expect(projectAuditRow(row({ action: 'pii.reveal', actor: 'owner-admin' }), tenant, platform).actor).toBe(t('partner.audit.smartremit'));
  });
  it('a long pii.view detail is cut on a word boundary, never mid-word', () => {
    const d = projectAuditRow(row({ action: 'pii.view', meta: { fields: ['full_name', 'date_of_birth', 'nationality', 'residential_address', 'occupation', 'source_of_funds'] } }), tenant).detail ?? '';
    expect(d).toContain('nationality');
    for (const w of d.replace(/^fields=/, '').replace(/…$/, '').split(' ')) expect(['full_name', 'date_of_birth', 'nationality', 'residential_address', 'occupation', 'source_of_funds']).toContain(w);
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
  it('the allowlist excludes screening, login and ops rows', () => {
    for (const a of ['sanctions.screen', 'aml.alert', 'aml.holds_set', 'kyc.start', 'auth.login', 'auth.login.failed', 'auth.login.success', 'auth.login.throttled', 'ops.outbox.retry', 'ops.outbox.dismiss', 'auth.mfa.reset', 'auth.mfa.failed', 'auth.stepup', 'ticket.triage', 'ticket.note', 'copilot.kyc_review']) {
      expect(TENANT_AUDIT_ACTIONS).not.toContain(a);
    }
  });
  it('holds the plan list, and every action has a label', () => {
    expect(TENANT_AUDIT_ACTIONS).toContain('transfer.release');
    expect(TENANT_AUDIT_ACTIONS).toContain('api_key.issue');
    expect(TENANT_AUDIT_ACTIONS).toContain('partner.support_contact.update'); // M3-17
    expect(TENANT_AUDIT_ACTIONS).toContain('partner.slug.claim'); // M3-18
    expect(TENANT_AUDIT_ACTIONS).toContain('partner.display_name.update'); // 2f
    expect(t(actionLabelKey('partner.display_name.update'))).toBe('Display name changed');
    expect(Object.isFrozen(TENANT_AUDIT_ACTIONS)).toBe(true);
    for (const a of TENANT_AUDIT_ACTIONS) expect(t(actionLabelKey(a)), a).not.toBe(actionLabelKey(a));
  });
});

// Lost-features restore (review BL-4): every action the four slices write or restore is labelled
// in ONE place, with the exact names their writers use.
const SLICE_ACTIONS: Record<string, string> = {
  // p1: transfers and refunds
  'transfer.cancel': 'Transfer cancelled',
  'transfer.assign': 'Transfer assigned',
  'transfer.paylink.resend': 'Payment link resent',
  'transfer.reject': 'Held transfer rejected',
  'refund.issue': 'Refund issued',
  'refund.approve': 'Refund approved',
  'refund.dismiss': 'Refund dismissed',
  'refund.retry': 'Refund retried',
  // p2: customers (KYC decisions own-only)
  'conversation.view': 'Conversation log viewed',
  'customer.create': 'Customer created',
  'kyc.manual_override.create': 'Customer created as verified',
  'kyc.manual_override.approve': 'KYC approved',
  'kyc.manual_override.reject': 'KYC rejected',
  'kyc.review.approve': 'KYC review approved',
  'kyc.review.reject': 'KYC review rejected',
  // BL-4: schedules and AML reviews (own-only)
  'schedule.create': 'Scheduled transfer created',
  'schedule.pause': 'Scheduled transfer paused',
  'schedule.resume': 'Scheduled transfer resumed',
  'schedule.cancel': 'Scheduled transfer cancelled',
  'aml.reviewed': 'AML alert reviewed',
  // p3: support, staff questions, invoices, password
  'ticket.assign': 'Ticket assigned',
  'ticket.escalate': 'Ticket escalated to SmartRemit',
  'ticket.escalation.withdraw': 'Escalation withdrawn',
  'ticket.status': 'Ticket status changed',
  'ticket.resolve': 'Ticket resolved',
  'ticket.close': 'Ticket closed',
  'ticket.reply': 'Ticket reply sent',
  'ticket.contact.open': 'Question sent',
  'ticket.contact.reply': 'Question follow-up sent',
  'employee_question.answer': 'Team question answered',
  'employee_question.status': 'Team question status changed',
  'b2b.invoice.void': 'Business invoice voided',
  'b2b.invoice.reissue': 'Business invoice reissued',
  'auth.password.change': 'Password changed',
  // p4: two-step recovery
  'customer.mfa.recovery.request': 'Two-step recovery requested',
  'customer.mfa.recovery.approve': 'Two-step recovery approved',
  'customer.mfa.recovery.decline': 'Two-step recovery declined',
};

describe('lost-features audit labels (BL-4)', () => {
  it('every slice action is allowlisted with its own label', () => {
    for (const [a, label] of Object.entries(SLICE_ACTIONS)) {
      expect(TENANT_AUDIT_ACTIONS, a).toContain(a);
      expect(t(actionLabelKey(a)), a).toBe(label);
    }
  });
  it('KYC decisions and AML reviews are own-only, and own-only actions are all allowlisted', () => {
    expect([...TENANT_OWN_ONLY_ACTIONS].sort()).toEqual(
      ['aml.reviewed', 'kyc.manual_override.approve', 'kyc.manual_override.create', 'kyc.manual_override.reject', 'kyc.review.approve', 'kyc.review.reject'].sort(),
    );
    expect(Object.isFrozen(TENANT_OWN_ONLY_ACTIONS)).toBe(true);
    for (const a of TENANT_OWN_ONLY_ACTIONS) expect(TENANT_AUDIT_ACTIONS).toContain(a);
  });
  it('reasons, notes, assignees and dispositions never render: these actions show no detail', () => {
    const meta = {
      reason: 'watchlist hit for +15550001111', note: 'called Jane', assignee: 'owner-admin', disposition: 'escalated',
      previousStatus: 'paid', from: 'open', to: 'paused', status: 'resolved', alertId: 7, reissuedAs: 'reissue-x', scheduleId: 'sch_1', ticketId: 'tk_1', via: 'portal',
    };
    const silent = Object.keys(SLICE_ACTIONS).filter((a) => !['conversation.view', 'customer.create', 'customer.mfa.recovery.approve', 'customer.mfa.recovery.decline'].includes(a));
    for (const action of silent) {
      const p = projectAuditRow(row({ action, meta }), tenant);
      expect(p.detail, action).toBeNull();
      for (const v of ['watchlist', '5550001111', 'Jane', 'owner-admin', 'escalated']) expect(JSON.stringify(p), action).not.toContain(v);
    }
  });
  it('the few safe details: conversation count and channel, the created KYC status, the recovery checks and decline reason', () => {
    expect(projectAuditRow(row({ action: 'conversation.view', meta: { count: 12, channel: 'wa', unreadable: 1, actorScope: 'partner' } }), tenant).detail).toBe('count=12, channel=wa');
    expect(projectAuditRow(row({ action: 'customer.create', meta: { kycStatus: 'not_started', senderCountry: 'US', source: 'manual' } }), tenant).detail).toBe('kycStatus=not_started');
    expect(projectAuditRow(row({ action: 'customer.mfa.recovery.approve', meta: { checks: ['id_document', 'recent_transfer'], ticketId: 'tk_1' } }), tenant).detail).toBe('checks=id_document recent_transfer');
    expect(projectAuditRow(row({ action: 'customer.mfa.recovery.decline', meta: { reason: 'not_verified', ticketId: 'tk_1' } }), tenant).detail).toBe('reason=not_verified');
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
    // Exclusive upper bound: the start of the next UTC day (the repo compares with <), so no row at
    // 23:59:59.9995 falls between two days.
    expect(f.to.toISOString()).toBe('2026-09-21T00:00:00.000Z');
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
