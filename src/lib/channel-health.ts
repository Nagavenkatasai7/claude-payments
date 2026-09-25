// channel-health — R2a: partner-visible WhatsApp channel failure signals.
//
// (The name `partner-health.ts` is taken by the U4 struggling-partner scorer;
// this module is the WhatsApp CHANNEL's health, fed by the send path.)
//
// Three layers, all keyed on the TENANT (never a phone):
//   1. Redis `wahealth:{partner}` — one JSON string of per-kind marks
//      {at, count, code?}, 7-day TTL. Hot, cheap, written on every event.
//   2. audit_events `whatsapp.channel_health` — ONE row per (partner, kind,
//      hour), deduped by SET NX `wahealthlog:{partner}:{kind}:{hour}`, so a
//      flood of failures cannot flood the ledger.
//   3. An `email.send` to the partner's own alertEmail (when set) — ONE per
//      (partner, kind, UTC day), fixed text + a dashboard link, for the kinds the
//      partner must act on.
// Only the Meta error CODE is ever stored: never a token, phone, body or payload.
// recordChannelHealth is BEST-EFFORT: it never throws (it runs inside the
// worker's catch, where an escaping error would abort the whole batch).

import { getDb, type DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { env } from './env';
import { logWarn } from './log';
import { DEFAULT_PARTNER_ID } from './defaults';
import { getStore, type Store } from './store';
import { resolveWaChannel, type WaChannel, type WaConfigField } from './whatsapp-creds';
import { signatureAlarm, type SignatureHealth } from './webhook-signature-health';
import type { PartnerId } from './types';

export const CHANNEL_HEALTH_KINDS = [
  'auth_error', // Graph 190 / 0 on a send — the partner's access token must be replaced
  'dead_send', // a whatsapp.text/template row dead-lettered
  'incomplete_config', // a send refused: the channel is partially configured
  'sig_fail', // inbound signature failures (R2b: shown from webhook-signature-health, never a mark; never emailed)
  'no_phone', // an inbound message without a phone number (R1)
  'delivery_failed', // Meta reported a failed delivery (R2b)
] as const;
export type ChannelHealthKind = (typeof CHANNEL_HEALTH_KINDS)[number];
const KIND_SET: ReadonlySet<string> = new Set(CHANNEL_HEALTH_KINDS);

/**
 * Kinds the partner must act on: these get the (daily) alert email. Never
 * `sig_fail`: a signature failure is unauthenticated traffic (banner hint only).
 */
const ALERTABLE: ReadonlySet<ChannelHealthKind> = new Set(['auth_error', 'dead_send', 'incomplete_config']);

export const CHANNEL_HEALTH_ACTION = 'whatsapp.channel_health';
/** The audit actions the partner-page banner reads (the R1 no-phone row included). */
export const CHANNEL_HEALTH_AUDIT_ACTIONS: readonly string[] = [CHANNEL_HEALTH_ACTION, 'whatsapp.inbound_no_phone'];

export const CHANNEL_HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface ChannelHealthMark {
  at: string;
  count: number;
  code?: number;
}
export type ChannelHealthMarks = Partial<Record<ChannelHealthKind, ChannelHealthMark>>;

// ── Pure helpers ────────────────────────────────────────────────────────────

export function applyHealthMark(
  marks: ChannelHealthMarks,
  kind: ChannelHealthKind,
  code: number | undefined,
  atIso: string,
): ChannelHealthMarks {
  const prev = marks[kind];
  const next: ChannelHealthMark = { at: atIso, count: (prev?.count ?? 0) + 1 };
  if (code !== undefined) next.code = code;
  return { ...marks, [kind]: next };
}

/** Defensive parse of the Redis JSON: unknown kinds and malformed marks are dropped. */
export function parseHealthMarks(raw: string | null | undefined): ChannelHealthMarks {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: ChannelHealthMarks = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KIND_SET.has(k) || !v || typeof v !== 'object') continue;
    const { at, count, code } = v as { at?: unknown; count?: unknown; code?: unknown };
    if (typeof at !== 'string' || typeof count !== 'number' || !Number.isFinite(count)) continue;
    const mark: ChannelHealthMark = { at, count };
    if (typeof code === 'number' && Number.isInteger(code)) mark.code = code;
    out[k as ChannelHealthKind] = mark;
  }
  return out;
}

export const healthHourBucket = (now: Date): number => Math.floor(now.getTime() / 3_600_000);

export function healthEmailDedupeKey(partnerId: PartnerId, kind: ChannelHealthKind, now: Date): string {
  return `partnerhealth:${partnerId}:${kind}:${now.toISOString().slice(0, 10)}`;
}

const ALERT_EMAIL_MAX = 254;
// One plain address: no whitespace, no list separators, no angle brackets.
const ALERT_EMAIL_RE = /^[^\s@,;<>"'()]+@[^\s@,;<>"'()]+\.[^\s@,;<>"'()]+$/;

/**
 * Validate a staff-entered alert address. '' ⇒ null (clear it); a single plain
 * address ⇒ the trimmed address; anything else (CR/LF, a list, junk, too long)
 * ⇒ undefined (refuse).
 */
export function normalizeAlertEmail(raw: string): string | null | undefined {
  const v = raw.trim();
  if (v === '') return null;
  if (v.length > ALERT_EMAIL_MAX || /[\r\n]/.test(raw) || !ALERT_EMAIL_RE.test(v)) return undefined;
  return v;
}

const FIELD_LABEL: Record<WaConfigField, string> = {
  phoneNumberId: 'Phone number ID',
  token: 'Access token',
  appSecret: 'App secret',
  verifyToken: 'Verify token',
};

const KIND_MESSAGE: Record<ChannelHealthKind, string> = {
  auth_error: 'WhatsApp rejected the access token (expired or revoked). Save a new access token on the WhatsApp tab.',
  dead_send: 'Some WhatsApp messages could not be delivered after retries.',
  incomplete_config: 'WhatsApp messages are NOT being sent because the WhatsApp channel is only partially configured.',
  sig_fail: "Some inbound webhook calls failed signature checks. If your bot isn't receiving messages, check the app secret.",
  no_phone: 'Some inbound messages arrived without a phone number and could not be answered.',
  delivery_failed: 'WhatsApp reported failed deliveries.',
};

const ERROR_KINDS: ReadonlySet<ChannelHealthKind> = new Set(['auth_error', 'dead_send', 'incomplete_config']);

export interface ChannelHealthItem {
  kind: ChannelHealthKind | 'config_warning';
  level: 'warn' | 'error';
  message: string;
  at?: string;
  count?: number;
  code?: number;
}

export interface ChannelHealthSummary {
  level: 'ok' | 'warn' | 'error';
  /** Absent when the channel was not read (the layout's Redis-only banner). */
  channelLabel?: 'own number' | 'shared SmartRemit number' | 'incomplete';
  items: ChannelHealthItem[];
}

/**
 * The banner model: the channel kind plus every mark from the last 7 days.
 * R2b: the signature item comes ONLY from `signature` (webhook-signature-health)
 * and only while signatureAlarm holds — a `sig_fail` Redis mark is ignored. It
 * is a WARN: failures alone can be produced by anyone, so they never raise the
 * error-level banner.
 */
export function summarizeChannelHealth(input: {
  channel?: WaChannel;
  marks: ChannelHealthMarks;
  now: Date;
  signature?: SignatureHealth;
}): ChannelHealthSummary {
  const items: ChannelHealthItem[] = [];
  const { channel } = input;
  if (channel?.kind === 'incomplete') {
    items.push({
      kind: 'incomplete_config',
      level: 'error',
      message: `WhatsApp channel is incomplete — missing: ${channel.missing.map((f) => FIELD_LABEL[f]).join(', ')}. Messages are not sent until it is completed or disconnected.`,
    });
  } else if (channel?.kind === 'own' && channel.warnings.length > 0) {
    items.push({
      kind: 'config_warning',
      level: 'warn',
      message: `WhatsApp channel is missing: ${channel.warnings.map((f) => FIELD_LABEL[f]).join(', ')}.`,
    });
  }
  const cutoff = input.now.getTime() - CHANNEL_HEALTH_WINDOW_MS;
  for (const kind of CHANNEL_HEALTH_KINDS) {
    if (kind === 'sig_fail') continue;
    const m = input.marks[kind];
    if (!m) continue;
    const t = Date.parse(m.at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (kind === 'incomplete_config' && items.some((i) => i.kind === 'incomplete_config')) continue;
    items.push({
      kind,
      level: ERROR_KINDS.has(kind) ? 'error' : 'warn',
      message: KIND_MESSAGE[kind],
      at: m.at,
      count: m.count,
      ...(m.code !== undefined ? { code: m.code } : {}),
    });
  }
  if (input.signature && signatureAlarm(input.signature, input.now)) {
    items.push({ kind: 'sig_fail', level: 'warn', message: KIND_MESSAGE.sig_fail, ...(input.signature.lastFailAt ? { at: input.signature.lastFailAt } : {}) });
  }
  const level = items.some((i) => i.level === 'error') ? 'error' : items.length > 0 ? 'warn' : 'ok';
  const channelLabel =
    channel?.kind === 'own' ? 'own number' : channel?.kind === 'incomplete' ? 'incomplete' : channel?.kind === 'shared' ? 'shared SmartRemit number' : undefined;
  return { level, ...(channelLabel ? { channelLabel } : {}), items };
}

export interface ChannelBannerModel {
  variant: 'default' | 'destructive';
  title: string;
  lines: string[];
  href: string;
}

/** Pure: what a page's banner shows for a summary (null ⇒ render nothing). */
export function channelBannerModel(summary: ChannelHealthSummary, partnerId: PartnerId): ChannelBannerModel | null {
  if (summary.level === 'ok') return null;
  return {
    variant: summary.level === 'error' ? 'destructive' : 'default',
    title: summary.level === 'error' ? 'WhatsApp channel needs attention' : 'WhatsApp channel notice',
    lines: summary.items.map((i) => {
      const extra = [i.count && i.count > 1 ? `×${i.count}` : '', i.code !== undefined ? `code ${i.code}` : '', i.at ? `last ${i.at.slice(0, 16).replace('T', ' ')} UTC` : '']
        .filter(Boolean)
        .join(' · ');
      return extra ? `${i.message} (${extra})` : i.message;
    }),
    href: `/admin-dashboard/partners/${encodeURIComponent(partnerId)}`,
  };
}

const EMAIL_SUBJECT: Record<ChannelHealthKind, string> = {
  auth_error: 'Action needed: your WhatsApp access token was rejected',
  dead_send: 'Action needed: WhatsApp messages could not be delivered',
  incomplete_config: 'Action needed: your WhatsApp channel is incomplete',
  sig_fail: 'Action needed: WhatsApp webhook signature failures',
  no_phone: 'WhatsApp channel notice',
  delivery_failed: 'WhatsApp channel notice',
};

/** FIXED text only (plus the dashboard link): never a code body, phone or token. */
export function buildHealthEmail(partnerId: PartnerId, kind: ChannelHealthKind): { subject: string; text: string } {
  const link = `${env.appBaseUrl}/admin-dashboard/partners/${encodeURIComponent(partnerId)}`;
  return {
    subject: `SmartRemit: ${EMAIL_SUBJECT[kind]}`,
    text: `${KIND_MESSAGE[kind]}\n\nOpen your dashboard to see details and fix it:\n${link}\n\nYou receive at most one email per issue per day. Change the alert address on the Support tab.`,
  };
}

// ── Effects ─────────────────────────────────────────────────────────────────

export interface ChannelHealthDeps {
  store: Pick<Store, 'readChannelHealth' | 'writeChannelHealth' | 'claimChannelHealthLog'>;
  db: DbOrTx;
  now?: () => Date;
}

/**
 * Record one channel-health event for a tenant. Best-effort — NEVER throws.
 * Returns true only when it queued a NEW alert email, so a caller outside the
 * worker knows to poke it (R2b).
 * The default tenant (the shared number) is skipped: it is the platform's own
 * channel and ops already sees its failures.
 * `audit: false` — the call site already wrote its own audit row (R1 no-phone):
 * Redis mark only (plus the email, for an alertable kind).
 */
export async function recordChannelHealth(
  partnerId: PartnerId | null | undefined,
  kind: ChannelHealthKind,
  opts: { code?: number; audit?: boolean } = {},
  deps?: ChannelHealthDeps,
): Promise<boolean> {
  if (!partnerId || partnerId === DEFAULT_PARTNER_ID) return false;
  try {
    const d: ChannelHealthDeps = deps ?? { store: getStore(), db: getDb() };
    const now = (d.now ?? (() => new Date()))();
    const marks = parseHealthMarks(await d.store.readChannelHealth(partnerId));
    await d.store.writeChannelHealth(partnerId, JSON.stringify(applyHealthMark(marks, kind, opts.code, now.toISOString())));
    // One ledger row (and at most one email attempt) per (partner, kind, hour).
    if (!(await d.store.claimChannelHealthLog(partnerId, kind, healthHourBucket(now)))) return false;
    if (opts.audit !== false) {
      await createAuditRepo(d.db).record({
        partnerId,
        actor: 'channel-health',
        actorType: 'system',
        action: CHANNEL_HEALTH_ACTION,
        meta: { kind, ...(opts.code !== undefined ? { code: opts.code } : {}) },
      });
    }
    if (ALERTABLE.has(kind)) {
      const partner = await createPartnerRepo(d.db).getPartner(partnerId);
      const to = partner?.supportConfig?.alertEmail;
      if (to && normalizeAlertEmail(to)) {
        const { subject, text } = buildHealthEmail(partnerId, kind);
        return await createOutboxRepo(d.db).enqueue('email.send', { to: [to], subject, text }, { dedupeKey: healthEmailDedupeKey(partnerId, kind, now) });
      }
    }
    return false;
  } catch (err) {
    logWarn('channel-health', 'health event not recorded', { partnerId, kind, error: err instanceof Error ? err.name : 'error' });
    return false;
  }
}

/** Pure: drop the given kinds (a fixed config / a passing connection test resolves them). */
export function clearHealthMarks(marks: ChannelHealthMarks, kinds: readonly ChannelHealthKind[]): ChannelHealthMarks {
  const out: ChannelHealthMarks = { ...marks };
  for (const k of kinds) delete out[k];
  return out;
}

/**
 * Clear resolved kinds from the partner's Redis marks (after a complete save, a
 * disconnect, or a passing "Test connection"). Best-effort — never throws; the
 * ledger's audit rows are append-only and stay as history.
 */
export async function clearChannelHealthMarks(
  partnerId: PartnerId,
  kinds: readonly ChannelHealthKind[],
  deps?: { store: Pick<Store, 'readChannelHealth' | 'writeChannelHealth'> },
): Promise<void> {
  try {
    const store = deps?.store ?? getStore();
    const raw = await store.readChannelHealth(partnerId);
    if (!raw) return;
    await store.writeChannelHealth(partnerId, JSON.stringify(clearHealthMarks(parseHealthMarks(raw), kinds)));
  } catch (err) {
    logWarn('channel-health', 'health marks not cleared', { partnerId, error: err instanceof Error ? err.name : 'error' });
  }
}

/** The last "Test connection" result, as stored (status code only — never a token or body). */
export interface ChannelTestResult {
  ok: boolean;
  at: string;
  status?: number;
  reason?: 'not_configured' | 'probe_failed';
}

export function parseChannelTest(raw: string | null | undefined): ChannelTestResult | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || typeof v.ok !== 'boolean' || typeof v.at !== 'string') return null;
    const out: ChannelTestResult = { ok: v.ok, at: v.at };
    if (typeof v.status === 'number' && Number.isInteger(v.status)) out.status = v.status;
    if (v.reason === 'not_configured' || v.reason === 'probe_failed') out.reason = v.reason;
    return out;
  } catch {
    return null;
  }
}

export interface ChannelHealthView {
  marks: ChannelHealthMarks;
  events: Array<{ action: string; meta: unknown; at: Date }>;
  channel?: WaChannel;
}

/**
 * The partner page's health read: Redis marks + the tenant-scoped audit rows of
 * the last 7 days (+ the channel kind when `includeChannel`, which decrypts the
 * integrations row — so the per-page layout banner uses the marks only).
 * The caller MUST pass a partnerId it has already authorized (canSee / scopeOf).
 */
export async function getChannelHealth(
  partnerId: PartnerId,
  deps: { store: Pick<Store, 'readChannelHealth'>; db: DbOrTx; now?: () => Date; includeChannel?: boolean },
): Promise<ChannelHealthView> {
  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - CHANNEL_HEALTH_WINDOW_MS);
  const [raw, events, integrations] = await Promise.all([
    deps.store.readChannelHealth(partnerId).catch(() => null),
    createAuditRepo(deps.db).listHealthByPartner(partnerId, since, CHANNEL_HEALTH_AUDIT_ACTIONS, 20),
    deps.includeChannel === false ? Promise.resolve(null) : createIntegrationsRepo(deps.db).getIntegrations(partnerId),
  ]);
  return {
    marks: parseHealthMarks(raw),
    events,
    ...(deps.includeChannel === false ? {} : { channel: resolveWaChannel(partnerId, integrations) }),
  };
}
