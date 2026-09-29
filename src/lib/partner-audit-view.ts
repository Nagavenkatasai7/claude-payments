import { t, type MessageKey } from '@/lib/i18n';
import { maskPhoneLast4 } from '@/lib/mask';

// partner-audit-view (UI redesign M3-4): the PURE half of the partner audit log viewer. A tenant sees
// its own trail through three allowlists, never the raw row:
//   1. ACTIONS: only the action types below are ever queried (platform-internal, screening, KYC
//      decision, sign-in and ops rows are left out on purpose: they carry evidence names, free-text
//      reasons or IP metadata);
//   2. ACTORS: a tenant username is shown; any other staff actor reads as "SmartRemit", and system /
//      API-key actors as a fixed label, so no other tenant's or platform's identifiers are rendered;
//   3. META: a per-action list of keys; every other meta key (reasons, old/new config, IPs, slugs,
//      colours) is dropped. Customer and phone-shaped subjects are masked.
// Audit-log hardening (separate role, TRUNCATE guard, off-site copy) is compliance loop A's (§6b).

// Adding an action here is a PII review: check its writer's subject_id shape (safeText masks only
// phone- and email-shaped values) and keep its meta out of DETAIL_KEYS unless every key is safe.
// Some entries (invites, go-live, reports, webhooks, hold notes) have no writer yet: their PRs own that review.
const ACTION_LABELS = Object.freeze({
  created: 'partner.audit.action.created',
  removed: 'partner.audit.action.removed',
  'staff.invite.create': 'partner.audit.action.staffInviteCreate',
  'staff.invite.revoke': 'partner.audit.action.staffInviteRevoke',
  'staff.invite.accept': 'partner.audit.action.staffInviteAccept',
  'api_key.issue': 'partner.audit.action.apiKeyIssue',
  'api_key.revoke': 'partner.audit.action.apiKeyRevoke',
  'partner.whatsapp_config': 'partner.audit.action.whatsappConfig',
  'partner.whatsapp.disconnect': 'partner.audit.action.whatsappDisconnect',
  'partner.support_config': 'partner.audit.action.supportConfig',
  'partner.alert_email.update': 'partner.audit.action.alertEmail',
  'partner.disclosure_config': 'partner.audit.action.disclosureConfig',
  'partner.persona.update': 'partner.audit.action.persona',
  'partner.theme.update': 'partner.audit.action.theme',
  'partner.logo.update': 'partner.audit.action.logo',
  'partner.slug.update': 'partner.audit.action.slug',
  'partner.support_contact.update': 'partner.audit.action.supportContact',
  'partner.settlement_endpoint.update': 'partner.audit.action.settlementEndpoint',
  'partner.settlement_secret.rotate': 'partner.audit.action.settlementSecret',
  'partner.go_live.request': 'partner.audit.action.goLiveRequest',
  'partner.go_live.approve': 'partner.audit.action.goLiveApprove',
  'pii.view': 'partner.audit.action.piiView',
  'pii.reveal': 'partner.audit.action.piiReveal',
  'send_limits.set': 'partner.audit.action.sendLimitsSet',
  'send_limits.clear': 'partner.audit.action.sendLimitsClear',
  'transfer.hold.note': 'partner.audit.action.holdNote',
  'transfer.release': 'partner.audit.action.release',
  'report.request': 'partner.audit.action.reportRequest',
  'report.download': 'partner.audit.action.reportDownload',
  'webhook.test': 'partner.audit.action.webhookTest',
  'webhook.replay': 'partner.audit.action.webhookReplay',
  'auth.mfa.enroll': 'partner.audit.action.mfaEnroll',
} as const satisfies Record<string, MessageKey>);

export type TenantAuditAction = keyof typeof ACTION_LABELS;

/** The ONLY action types a partner's audit view ever queries or renders. */
export const TENANT_AUDIT_ACTIONS: readonly TenantAuditAction[] = Object.freeze(
  Object.keys(ACTION_LABELS) as TenantAuditAction[],
);

const isTenantAction = (a: string): a is TenantAuditAction => Object.hasOwn(ACTION_LABELS, a);

export function actionLabelKey(action: string): MessageKey {
  return isTenantAction(action) ? ACTION_LABELS[action] : 'partner.audit.action.other';
}

/** Per-action meta keys a tenant may see. An action not listed shows no detail at all. */
const DETAIL_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'api_key.issue': ['mode', 'last4'],
  'api_key.revoke': ['last4'],
  'pii.reveal': ['field'],
  'pii.view': ['fields'],
  'report.request': ['kind'],
  'webhook.replay': ['deliveryId'],
});

const MASK = '••••'; // ••••
const PHONE_SHAPE = /^\+?[\d\s().-]{8,24}$/;
const DIGIT_RUN = /\d{7,}/;
const CUSTOMER_SUBJECT = /^cust:([0-9a-f]{6})[0-9a-f]*$/i;
const MAX_DETAIL = 80;

/** A value that could be a phone or an email never reaches the page. */
function safeText(v: string): string {
  if (v.includes('@')) return MASK;
  if (PHONE_SHAPE.test(v) || DIGIT_RUN.test(v)) return maskPhoneLast4(v);
  return v;
}

function detailValue(v: unknown): string | null {
  let s: string;
  if (Array.isArray(v)) s = v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String).join(' ');
  else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else return null; // objects are never rendered
  s = safeText(s.trim());
  if (!s) return null;
  if (s.length <= MAX_DETAIL) return s;
  // Cut on a word boundary (never mid-word), marked with an ellipsis.
  const cut = s.slice(0, MAX_DETAIL + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : s.slice(0, MAX_DETAIL)).trimEnd()}…`;
}

export interface TenantAuditRow {
  id: number;
  at: Date;
  actor: string;
  actorType: string;
  action: string;
  subjectId: string | null;
  meta: unknown;
}

export interface ProjectedAuditRow {
  at: string;
  actor: string;
  action: string;
  subject: string;
  detail: string | null;
}

const NO_PLATFORM: ReadonlySet<string> = new Set();

function projectActor(row: TenantAuditRow, tenantUsernames: ReadonlySet<string>, platformUsernames: ReadonlySet<string>): string {
  if (row.actorType === 'system') return t('partner.audit.system');
  if (row.actorType === 'api_key') return t('partner.audit.apiKey');
  if (row.actorType !== 'staff') return t('partner.audit.smartremit');
  // Only the created/removed writers set an actorScope marker (partner-demo R5); most staff writers
  // (pii.view, pii.reveal, api_key.*, whatsapp config…) write none. So: a 'platform' marker or a
  // CURRENT platform account → "SmartRemit"; a 'partner' marker or a CURRENT member of this tenant →
  // their name; anyone else (an offboarded member, a deleted account) → "Former staff", never
  // "SmartRemit": the log must not blame the platform for an ex-employee's reveal.
  const scope = row.meta && typeof row.meta === 'object' ? (row.meta as { actorScope?: unknown }).actorScope : undefined;
  if (scope === 'platform') return t('partner.audit.smartremit');
  if (scope === 'partner' || tenantUsernames.has(row.actor)) return safeText(row.actor); // a legacy email-shaped name is masked
  if (platformUsernames.has(row.actor)) return t('partner.audit.smartremit');
  return t('partner.audit.formerStaff');
}

function projectSubject(subjectId: string | null): string {
  if (!subjectId) return '';
  const c = CUSTOMER_SUBJECT.exec(subjectId);
  if (c) return `${t('partner.audit.customer')} ${c[1].toLowerCase()}`;
  if (subjectId.startsWith('cust:')) return t('partner.audit.customer');
  return safeText(subjectId);
}

function projectDetail(action: string, meta: unknown): string | null {
  const keys = DETAIL_KEYS[action];
  if (!keys || !meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of keys) {
    if (!Object.hasOwn(m, k)) continue;
    const v = detailValue(m[k]);
    if (v !== null) parts.push(`${k}=${v}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/** The ONLY shape an audit row takes on a tenant's screen. Raw meta never leaves this function. */
export function projectAuditRow(
  row: TenantAuditRow,
  tenantUsernames: ReadonlySet<string>,
  platformUsernames: ReadonlySet<string> = NO_PLATFORM,
): ProjectedAuditRow {
  return {
    at: row.at.toISOString(),
    actor: projectActor(row, tenantUsernames, platformUsernames),
    action: row.action,
    subject: projectSubject(row.subjectId),
    detail: projectDetail(row.action, row.meta),
  };
}

// ── Filters (search params are edge input: closed sets, bounded dates) ──

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const DAY_MS = 86_400_000;
export const AUDIT_MAX_WINDOW_DAYS = 90;
export const AUDIT_DEFAULT_WINDOW_DAYS = 30;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A strict YYYY-MM-DD as the start of that UTC day; an impossible date (2026-02-30) is undefined. */
function parseDay(v: string | undefined): Date | undefined {
  const m = v ? YMD.exec(v) : null;
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v ? d : undefined;
}

export interface AuditFilters {
  actions: string[];
  actor?: string;
  from: Date;
  to: Date;
}

export function parseAuditFilters(sp: SearchParams, tenantUsernames: readonly string[], now: Date): AuditFilters {
  const action = first(sp.action);
  const actorIn = first(sp.actor);
  const actions = action !== undefined && isTenantAction(action) ? [action] : [...TENANT_AUDIT_ACTIONS];
  const actor = actorIn !== undefined && tenantUsernames.includes(actorIn) ? actorIn : undefined;

  const floor = now.getTime() - AUDIT_MAX_WINDOW_DAYS * DAY_MS;
  const toDay = parseDay(first(sp.to));
  // Exclusive upper bound (the repo compares with <): the start of the next UTC day, capped at now.
  let to = toDay ? new Date(Math.min(toDay.getTime() + DAY_MS, now.getTime())) : now;
  const fromDay = parseDay(first(sp.from));
  let from = fromDay ? new Date(Math.max(fromDay.getTime(), floor)) : new Date(to.getTime() - AUDIT_DEFAULT_WINDOW_DAYS * DAY_MS);
  if (from.getTime() < floor) from = new Date(floor);
  if (from.getTime() > to.getTime()) {
    to = now;
    from = new Date(now.getTime() - AUDIT_DEFAULT_WINDOW_DAYS * DAY_MS);
  }
  return actor ? { actions, actor, from, to } : { actions, from, to };
}

// ── The keyset cursor: `<epoch ms, 13 digits>.<row id>` (no PII; ignored when malformed) ──

const CURSOR = /^(\d{13})\.(\d{1,15})$/;

export function parseAuditCursor(v: string | string[] | undefined): { at: Date; id: number } | undefined {
  const m = CURSOR.exec(first(v) ?? '');
  if (!m) return undefined;
  const ms = Number(m[1]);
  const id = Number(m[2]);
  if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(id) || id < 1) return undefined;
  return { at: new Date(ms), id };
}

export function auditCursorOf(row: { at: Date; id: number }): string {
  return `${row.at.getTime()}.${row.id}`;
}
