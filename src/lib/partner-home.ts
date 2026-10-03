import { keyModeFromId } from './partner-api-scopes';
import { PARTNER_MONEY_READ, type PartnerRole } from './partner-access';
import { checkSettlementUrl, type SettlementUrlOptions } from './settlement-url';
import type { ChannelHealthSummary } from './channel-health';
import type { PartnerPaymentConfig } from './partner-integrations';

// partner-home: the PURE view model behind /partner (UI redesign M3-3). The page reads each source
// read-only and tenant-scoped (the session partnerId), passes null for a source that failed, and
// renders this model. No PII enters it: counts, rounded USD amounts from the ledger aggregate, and
// health states only. A failed source marks only its own part as 'error' (fail-soft per card).

export type HealthState = 'ok' | 'attention' | 'off';
export type HealthView = HealthState | 'error';

export interface PartnerHomeInput {
  role: PartnerRole;
  /** transfersSummary(partnerId): live rows only; "today" is the ledger's America/New_York day. */
  summary: {
    countToday: number;
    volumeToday: number;
    commissionToday: number;
    /** Today's live rows whose compliance status is flagged or blocked: a count, never a list. */
    flaggedToday: number;
    /** All-time live rows (any status), their volume, and fees on paid/delivered rows. */
    total: number;
    volumeAllTime: number;
    commissionAllTime: number;
    needsAttention: number;
    byStatus: Record<string, number>;
  } | null;
  whatsapp: HealthState | null;
  settlement: HealthState | null;
  apiKeys: ReadonlyArray<{ keyId: string; revokedAt?: string; lastUsedAt?: string }> | null;
  /**
   * Lost-features A12, admins only: team questions waiting for an answer. Omitted when not read
   * (other roles); null when the read failed.
   */
  teamQuestions?: number | null;
  now: Date;
}

export interface PartnerKpis {
  countToday: number;
  volumeTodayUsd: number;
  feesTodayUsd: number;
  /** A bare count (p3 B11): it names nobody and matches the analytics compliance donut. */
  flaggedToday: number;
  allTime: { count: number; volumeUsd: number; feesUsd: number };
}

export type PartnerActionKey = 'holds' | 'attention' | 'whatsapp' | 'webhooks' | 'no_live_key' | 'team_questions';

export interface PartnerHomeModel {
  health: Array<{ key: 'whatsapp' | 'webhooks' | 'api'; state: HealthView }>;
  /** null for roles without money read; 'error' when the ledger aggregate failed. */
  kpis: PartnerKpis | 'error' | null;
  actions: Array<{ key: PartnerActionKey; count: number }>;
  /** True when a source behind the actions failed, so an empty list is not "nothing to do". */
  actionsIncomplete: boolean;
}

const WEEK_MS = 7 * 86_400_000;

function apiHealth(keys: NonNullable<PartnerHomeInput['apiKeys']>, now: Date): HealthState {
  const live = keys.filter((k) => !k.revokedAt && keyModeFromId(k.keyId) === 'live');
  if (live.length === 0) return keys.some((k) => !k.revokedAt) ? 'attention' : 'off';
  const recent = live.some((k) => {
    if (!k.lastUsedAt) return false;
    const at = Date.parse(k.lastUsedAt);
    return Number.isFinite(at) && now.getTime() - at <= WEEK_MS;
  });
  return recent ? 'ok' : 'attention';
}

/**
 * WhatsApp from the channel-health summary (channel-health.ts summarizeChannelHealth). The shared
 * SmartRemit number is a working channel, so it is 'ok' while no mark is active; an incomplete
 * own-number config is an error-level item, so 'attention'. 'off' only when no channel was read.
 */
export function whatsappHealth(s: ChannelHealthSummary): HealthState {
  if (!s.channelLabel) return 'off';
  return s.level === 'ok' ? 'ok' : 'attention';
}

const ROUTABLE = new Set(['http', 'simulator']);

/**
 * The settlement endpoint (the us→partner signed instruction). Absent or mock rail: 'off'. An
 * http/simulator rail whose URL passes the same sync rule the worker applies before any fetch
 * (settlement-url.ts checkSettlementUrl): 'ok'. Anything else would dead-letter money: 'attention'.
 */
export function settlementHealth(payment: PartnerPaymentConfig, opts: SettlementUrlOptions): HealthState {
  const type = payment.providerType ?? '';
  if (type === '' || type === 'mock') return 'off';
  if (!ROUTABLE.has(type)) return 'attention';
  const url = payment.credentials?.settlementUrl ?? '';
  return url !== '' && checkSettlementUrl(url, opts).ok ? 'ok' : 'attention';
}

export function buildPartnerHome(i: PartnerHomeInput): PartnerHomeModel {
  const api: HealthView = i.apiKeys === null ? 'error' : apiHealth(i.apiKeys, i.now);
  const health: PartnerHomeModel['health'] = [
    { key: 'whatsapp', state: i.whatsapp ?? 'error' },
    { key: 'webhooks', state: i.settlement ?? 'error' },
    { key: 'api', state: api },
  ];
  const kpis: PartnerHomeModel['kpis'] = !PARTNER_MONEY_READ.roles.includes(i.role)
    ? null
    : i.summary === null
      ? 'error'
      : {
          countToday: i.summary.countToday,
          volumeTodayUsd: i.summary.volumeToday,
          feesTodayUsd: i.summary.commissionToday,
          flaggedToday: i.summary.flaggedToday,
          allTime: { count: i.summary.total, volumeUsd: i.summary.volumeAllTime, feesUsd: i.summary.commissionAllTime },
        };
  const isAdmin = i.role === 'admin';
  const unhealthy = (s: HealthState | null) => (s !== null && s !== 'ok' ? 1 : 0);
  const candidates: PartnerHomeModel['actions'] = [
    { key: 'holds', count: i.summary?.byStatus.in_review ?? 0 },
    { key: 'attention', count: i.summary?.needsAttention ?? 0 },
    { key: 'whatsapp', count: unhealthy(i.whatsapp) },
    { key: 'webhooks', count: unhealthy(i.settlement) },
    { key: 'no_live_key', count: api === 'off' ? 1 : 0 },
    { key: 'team_questions', count: isAdmin ? (i.teamQuestions ?? 0) : 0 },
  ];
  return {
    health,
    kpis,
    actions: candidates.filter((a) => a.count > 0),
    actionsIncomplete:
      i.summary === null ||
      i.whatsapp === null ||
      i.settlement === null ||
      i.apiKeys === null ||
      (isAdmin && i.teamQuestions === null),
  };
}
