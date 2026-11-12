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
  it('lost-features p2 B6: the extra pii.view field names render as plain names', () => {
    const d = projectAuditRow(row({ action: 'pii.view', meta: { fields: ['gov_id_last4', 'pep_declared'] } }), tenant).detail ?? '';
    expect(d).toBe('fields=gov_id_last4 pep_declared');
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
    for (const a of ['sanctions.screen', 'aml.alert', 'aml.holds_set', 'risk_signals.set', 'aml.hold', 'customer.consent.esign', 'kyc.start', 'auth.login', 'auth.login.failed', 'auth.login.success', 'auth.login.throttled', 'ops.outbox.retry', 'ops.outbox.dismiss', 'auth.mfa.reset', 'auth.mfa.failed', 'auth.stepup', 'ticket.triage', 'ticket.note', 'copilot.kyc_review', 'refund.record_outside']) {
      expect(TENANT_AUDIT_ACTIONS).not.toContain(a);
    }
  });
  // Fix pack 6 T19 (P21): the partner's own AML hold rule changes (and SmartRemit's go-live
  // default) are in the feed; the platform switch, the per-transfer hold and the rule names that
  // held a transfer are not.
  it('aml.hold_rules_set is in the tenant feed with country and to only; aml.holds_set and aml.hold stay out', () => {
    expect(TENANT_AUDIT_ACTIONS).toContain('aml.hold_rules_set');
    expect(TENANT_AUDIT_ACTIONS).not.toContain('aml.holds_set');
    expect(TENANT_AUDIT_ACTIONS).not.toContain('aml.hold');
    expect(TENANT_OWN_ONLY_ACTIONS).not.toContain('aml.hold_rules_set');
    expect(t(actionLabelKey('aml.hold_rules_set'))).toBe('AML hold rules changed');
    const meta = { country: 'US', from: ['structuring', 'first_transfer', 'new_beneficiary'], to: ['structuring'], actorScope: 'partner', extra: 'x' };
    const own = projectAuditRow(row({ action: 'aml.hold_rules_set', actor: 'pa-admin', subjectId: 'pa', meta }), tenant);
    expect(own.actor).toBe('pa-admin');
    expect(own.detail).toBe('country=US, to=structuring');
    for (const v of ['first_transfer', 'new_beneficiary', 'extra', 'actorScope', 'from=']) expect(JSON.stringify(own)).not.toContain(v);
    const platformRow = projectAuditRow(row({ action: 'aml.hold_rules_set', actor: 'owner-admin', subjectId: 'pa', meta: { ...meta, actorScope: 'platform', reason: 'go_live_default' } }), tenant, platform);
    expect(platformRow.actor).toBe(t('partner.audit.smartremit'));
    expect(JSON.stringify(platformRow)).not.toContain('owner-admin');
    expect(JSON.stringify(platformRow)).not.toContain('go_live_default');
  });
  // Fix pack 6 T28 (P21): the mint's record of the pay-page warning is in the feed with its
  // enum detail only; the platform writer (risk_signals.set) and the consent rows stay out.
  it('risk.signals is in TENANT_AUDIT_ACTIONS with its own label', () => {
    expect(TENANT_AUDIT_ACTIONS).toContain('risk.signals');
    expect(TENANT_OWN_ONLY_ACTIONS).not.toContain('risk.signals');
    expect(actionLabelKey('risk.signals')).toBe('partner.audit.action.riskSignals');
    expect(t(actionLabelKey('risk.signals'))).toBe('Payment warning recorded');
    for (const a of ['risk_signals.set', 'aml.hold', 'customer.consent.esign']) expect(TENANT_AUDIT_ACTIONS).not.toContain(a);
  });
  it('risk.signals detail shows shown, held and acked only (never derived, warningVersion, ackedAt, checkFailed)', () => {
    const meta = {
      shown: ['first_transfer', 'chat_cue'],
      derived: ['amount_over_threshold'],
      acked: true,
      held: ['first_transfer'],
      warningVersion: 'rw-2026-11.1-draft',
      ackedAt: new Date(Date.now() - 60_000).toISOString(),
      checkFailed: true,
    };
    const r = projectAuditRow(row({ action: 'risk.signals', actor: 'system:risk-signals', actorType: 'system', subjectId: 'tx_abc123', meta }), tenant);
    expect(r.detail).toBe('shown=first_transfer chat_cue, held=first_transfer, acked=true');
    for (const v of ['derived', 'amount_over_threshold', 'warningVersion', 'rw-2026', 'ackedAt', meta.ackedAt, 'checkFailed']) {
      expect(JSON.stringify(r)).not.toContain(v);
    }
    expect(r.subject).toBe('tx_abc123');
  });
  it("a risk.signals row with actorType 'system' (actor 'system:risk-signals') reads as the system label", () => {
    const r = projectAuditRow(row({ action: 'risk.signals', actor: 'system:risk-signals', actorType: 'system', meta: { shown: [], held: [], acked: false } }), tenant);
    expect(r.actor).toBe(t('partner.audit.system'));
    expect(JSON.stringify(r)).not.toContain('system:risk-signals');
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
      [
        'aml.reviewed',
        'kyc.manual_override.approve',
        'kyc.manual_override.create',
        'kyc.manual_override.reject',
        'kyc.review.approve',
        'kyc.review.reject',
        // Fix pack 7 T18 (P28, P10-critic): the hold decisions, the evidence views and SmartRemit's
        // KYC recommendations are the tenant's own rows only (a feed of SmartRemit's would be a screening list, D6).
        'transfer.hold.review',
        'transfer.screening.view',
        'kyc.recommend',
      ].sort(),
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
  it('partner.live.posture.sign and partner.live.compliance_user.set are labelled and show only their safe keys (fix pack 3 T9)', () => {
    expect(TENANT_AUDIT_ACTIONS).toContain('partner.live.posture.sign');
    expect(TENANT_AUDIT_ACTIONS).toContain('partner.live.compliance_user.set');
    expect(t(actionLabelKey('partner.live.posture.sign'))).toBe('Compliance posture signed');
    expect(t(actionLabelKey('partner.live.compliance_user.set'))).toBe('Compliance users changed');
    const sign = projectAuditRow(
      row({ action: 'partner.live.posture.sign', subjectId: 'pa', meta: { version: 1, kycDecider: 'partner', holdDecider: 'smartremit_delegated', fourEyesNonSanctions: true, actorScope: 'partner', reason: 'SECRET_REASON' } }),
      tenant,
    );
    expect(sign.detail).toBe('kycDecider=partner, holdDecider=smartremit_delegated, fourEyesNonSanctions=true');
    const set = projectAuditRow(row({ action: 'partner.live.compliance_user.set', subjectId: 'pa', meta: { target: 'pa-ops', on: false, actorScope: 'partner', ref: 'SECRET_REF' } }), tenant);
    expect(set.detail).toBe('target=pa-ops, on=false');
    for (const p of [sign, set]) for (const v of ['SECRET_REASON', 'SECRET_REF', 'actorScope']) expect(JSON.stringify(p)).not.toContain(v);
  });
});

describe('fix pack 3 T11: switch changes and capability approvals in the tenant feed', () => {
  it('flag.change shows key, enabled, corridor only (never reason, scopeId, previous); optin.approve shows capability, on; optin.counsel not in TENANT_AUDIT_ACTIONS', () => {
    expect(TENANT_AUDIT_ACTIONS).toContain('flag.change');
    expect(TENANT_AUDIT_ACTIONS).toContain('partner.live.optin.approve');
    expect(TENANT_AUDIT_ACTIONS).not.toContain('partner.live.optin.counsel');
    expect(t(actionLabelKey('flag.change'))).toBe('Switch changed');
    expect(t(actionLabelKey('partner.live.optin.approve'))).toBe('Live feature approval changed');
    const flag = projectAuditRow(
      row({
        action: 'flag.change',
        subjectId: 'sends.paused:partner:tenant:pa:IN',
        meta: { key: 'sends.paused', scopeType: 'partner', scopeId: 'tenant:pa:IN', corridor: 'IN', enabled: true, previous: false, reason: 'SECRET_REASON pausing', actorScope: 'partner' },
      }),
      tenant,
    );
    expect(flag.actor).toBe('pa-admin');
    expect(flag.detail).toBe('key=sends.paused, enabled=true, corridor=IN');
    const approve = projectAuditRow(row({ action: 'partner.live.optin.approve', subjectId: 'pa', meta: { capability: 'b2b', on: true, actorScope: 'partner', counselRef: 'SECRET_REF' } }), tenant);
    expect(approve.detail).toBe('capability=b2b, on=true');
    for (const p of [flag, approve]) for (const v of ['SECRET_REASON', 'SECRET_REF', 'previous', 'scopeType', 'actorScope']) expect(JSON.stringify(p)).not.toContain(v);
  });
  it("a PLATFORM-written flag.change row for this tenant (applyFlagChange: partnerId = the tenant id, a platform actor, no actorScope) shows actor 'SmartRemit' and key/enabled only", () => {
    const platformRow = row({
      action: 'flag.change',
      actor: 'owner-admin',
      subjectId: 'settlement.paused:partner:pa',
      meta: { key: 'settlement.paused', scopeType: 'partner', scopeId: 'pa', enabled: true, previous: false, reason: 'PLATFORM_SECRET_REASON' },
    });
    for (const p of [projectAuditRow(platformRow, tenant), projectAuditRow(platformRow, tenant, platform)]) {
      expect(p.actor).toBe(t('partner.audit.smartremit'));
      expect(p.detail).toBe('key=settlement.paused, enabled=true');
      for (const v of ['owner-admin', 'PLATFORM_SECRET_REASON', 'previous']) expect(JSON.stringify(p)).not.toContain(v);
    }
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

describe('partner.kyc_mode.change (pack 3 review C3)', () => {
  it('is in the tenant feed with its own label, as SmartRemit, and never shows its meta', () => {
    expect(TENANT_AUDIT_ACTIONS).toContain('partner.kyc_mode.change');
    expect(t(actionLabelKey('partner.kyc_mode.change'))).toBe('KYC handling changed');
    const p = projectAuditRow(
      row({ action: 'partner.kyc_mode.change', actor: 'owner-admin', subjectId: 'pa', meta: { from: 'ours', to: 'delegated', postureSigned: true } }),
      tenant,
      platform,
    );
    expect(p.actor).toBe(t('partner.audit.smartremit'));
    expect(p.detail).toBeNull();
  });
});

describe('otp.verified (pack 4 C17)', () => {
  // The full C17 meta of a pay-page payment: only the closed `channel` enum may reach a tenant.
  const fullMeta = {
    surface: 'transfer',
    channel: 'wa',
    issuedAt: '2026-09-01T09:59:00.000Z',
    verifiedAt: '2026-09-01T10:00:00.000Z',
    attempt: 1,
    ipHash: 'ih1:SECRET_IP_HASH',
    uaHash: 'uh1:SECRET_UA_HASH',
    disclosureVersion: 'SECRET_DISCLOSURE_VERSION',
    payloadHash: 'ph1:SECRET_PAYLOAD_HASH',
    routeId: 'SECRET_ROUTE_ID',
  };
  const otpRow = () => row({ action: 'otp.verified', actor: 'pay-page', actorType: 'system', subjectId: 'tx_minted_0001', meta: fullMeta });
  it("is in TENANT_AUDIT_ACTIONS with the label 'Payment approved with a code'", () => {
    expect(TENANT_AUDIT_ACTIONS).toContain('otp.verified');
    expect(t(actionLabelKey('otp.verified'))).toBe('Payment approved with a code');
  });
  it('a row with full C17 meta shows only channel=wa (never ipHash, uaHash, payloadHash, routeId, issuedAt, verifiedAt, attempt, disclosureVersion)', () => {
    const p = projectAuditRow(otpRow(), tenant, platform);
    expect(p.detail).toBe('channel=wa');
    const json = JSON.stringify(p);
    for (const v of ['ipHash', 'uaHash', 'payloadHash', 'routeId', 'issuedAt', 'verifiedAt', 'attempt', 'disclosureVersion', 'surface', 'SECRET']) {
      expect(json).not.toContain(v);
    }
  });
  it('the actor reads as the system label; the subject (a transfer id) is shown', () => {
    const p = projectAuditRow(otpRow(), tenant, platform);
    expect(p.actor).toBe(t('partner.audit.system'));
    expect(p.actor).not.toContain('pay-page');
    expect(p.subject).toBe('tx_minted_0001');
  });
  it('remittance.disclosure_ack and transfer.legal_name_set stay OUT of the feed', () => {
    expect(TENANT_AUDIT_ACTIONS).not.toContain('remittance.disclosure_ack');
    expect(TENANT_AUDIT_ACTIONS).not.toContain('transfer.legal_name_set');
    expect(actionLabelKey('remittance.disclosure_ack')).toBe('partner.audit.action.other');
    expect(actionLabelKey('transfer.legal_name_set')).toBe('partner.audit.action.other');
  });
});

// Fix pack 7 T18 (P28): the hold decision, escalation, evidence view, events URL and KYC
// recommendation rows. Closed-enum detail only; never a reason, list name, score or class list.
describe('fix pack 7 T18: hold decision audit rows', () => {
  const PACK7: Record<string, string> = {
    'transfer.hold.review': 'Hold decision recorded',
    'transfer.hold.escalate': 'SmartRemit asked you to decide a hold',
    'transfer.screening.view': 'Screening evidence viewed',
    'partner.events_endpoint.update': 'Compliance events URL changed',
    'kyc.recommend': 'SmartRemit recommendation',
  };
  it('pack 7 labels: each action is in TENANT_AUDIT_ACTIONS with its exact English label', () => {
    for (const [a, label] of Object.entries(PACK7)) {
      expect(TENANT_AUDIT_ACTIONS, a).toContain(a);
      expect(t(actionLabelKey(a)), a).toBe(label);
    }
    expect(actionLabelKey('transfer.hold.review')).toBe('partner.audit.action.holdReview');
    expect(actionLabelKey('transfer.hold.escalate')).toBe('partner.audit.action.holdEscalate');
    expect(actionLabelKey('transfer.screening.view')).toBe('partner.audit.action.screeningView');
    expect(actionLabelKey('partner.events_endpoint.update')).toBe('partner.audit.action.eventsEndpointUpdate');
    expect(actionLabelKey('kyc.recommend')).toBe('partner.audit.action.kycRecommend');
  });
  it('transfer.hold.review shows holdClass, disposition and step only', () => {
    const meta = { reviewId: 'hr_1', step: 1, final: true, disposition: 'docs_verified', holdClass: 'kyc', actorScope: 'partner', reason: 'secret note' };
    const p = projectAuditRow(row({ action: 'transfer.hold.review', subjectId: 'tr_abc123', meta }), tenant);
    expect(p.actor).toBe('pa-admin');
    expect(p.detail).toBe('holdClass=kyc, disposition=docs_verified, step=1');
    for (const v of ['hr_1', 'secret note', 'actorScope', 'final', 'reviewId']) expect(JSON.stringify(p), v).not.toContain(v);
  });
  it('transfer.hold.review, transfer.screening.view and kyc.recommend are own-only; escalate and the events URL are not', () => {
    for (const a of ['transfer.hold.review', 'transfer.screening.view', 'kyc.recommend']) expect(TENANT_OWN_ONLY_ACTIONS, a).toContain(a);
    for (const a of ['transfer.hold.escalate', 'partner.events_endpoint.update']) expect(TENANT_OWN_ONLY_ACTIONS, a).not.toContain(a);
  });
  it('escalate, screening view and kyc.recommend show no detail; escalate by SmartRemit staff reads as SmartRemit', () => {
    const meta = { holdClasses: ['sanctions_review'], recommendation: 'reject', reason: 'SECRET_REASON', actorScope: 'platform' };
    for (const action of ['transfer.hold.escalate', 'transfer.screening.view', 'kyc.recommend']) {
      const p = projectAuditRow(row({ action, meta }), tenant);
      expect(p.detail, action).toBeNull();
      for (const v of ['sanctions_review', 'holdClasses', 'recommendation', 'SECRET_REASON']) expect(JSON.stringify(p), action).not.toContain(v);
    }
    const esc = projectAuditRow(row({ action: 'transfer.hold.escalate', actor: 'owner-admin', subjectId: 'tr_abc123', meta: { holdClasses: ['sanctions_review'], actorScope: 'platform' } }), tenant, platform);
    expect(esc.actor).toBe(t('partner.audit.smartremit'));
    expect(JSON.stringify(esc)).not.toContain('owner-admin');
    expect(esc.detail).toBeNull();
  });
  it('partner.events_endpoint.update shows host only', () => {
    const p = projectAuditRow(row({ action: 'partner.events_endpoint.update', subjectId: 'pa', meta: { host: 'events.example.test', actorScope: 'partner' } }), tenant);
    expect(p.detail).toBe('host=events.example.test');
    expect(JSON.stringify(p)).not.toContain('actorScope');
  });
  it('refund.record_outside stays out of the tenant feed (platform-only)', () => {
    expect(TENANT_AUDIT_ACTIONS).not.toContain('refund.record_outside');
    expect(actionLabelKey('refund.record_outside')).toBe('partner.audit.action.other');
  });
});
