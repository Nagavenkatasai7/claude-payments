import type { PartnerId } from './types';

// Meta account events → ops alerts (2026-10-03, Batch 1 A5). Three WhatsApp
// Business Account webhook fields carry no customer message, only news about
// the account itself:
//   message_template_status_update  a template was approved, rejected, paused…
//   template_category_update        Meta re-labelled (or will re-label) a template's category
//   phone_number_quality_update     the number's quality rating or messaging limit changed
// Until now the webhook parsed them as empty changes and nothing happened, so a
// rejected or paused template was only found when sends started failing. Shapes
// per Meta's webhook reference (developers.facebook.com/docs/whatsapp/cloud-api/
// webhooks/reference/<field>; read via pywa's parser, pywa/types/templates.py,
// because developers.facebook.com is not reachable from the build machine).
// Every field is read defensively: a missing or odd value is left out, never
// guessed, and nothing here throws.

export const META_ACCOUNT_FIELDS = [
  'message_template_status_update',
  'template_category_update',
  'phone_number_quality_update',
] as const;
export type MetaAccountField = (typeof META_ACCOUNT_FIELDS)[number];

export function isMetaAccountField(field: unknown): field is MetaAccountField {
  return (META_ACCOUNT_FIELDS as readonly unknown[]).includes(field);
}

export interface MetaAccountEvent {
  field: MetaAccountField;
  /** entry[].time (Unix seconds) when Meta sent it; null when absent. */
  time: number | null;
  /** Template events: name + language. */
  templateName?: string;
  templateLanguage?: string;
  /** Status event (APPROVED, REJECTED, PAUSED…) or quality event (FLAGGED, DOWNGRADE…). */
  event?: string;
  /** Rejection / pause reason, e.g. INCORRECT_CATEGORY. */
  reason?: string;
  previousCategory?: string;
  newCategory?: string;
  correctCategory?: string;
  /** Quality events: the number's last 4 digits only, never the full number. */
  phoneLast4?: string;
  currentLimit?: string;
}

const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,100}$/;
const LANG_RE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;
// Meta's enum-style values: APPROVED, INCORRECT_CATEGORY, TIER_1K, UTILITY…
const ENUM_RE = /^[A-Z0-9_]{1,40}$/;

function pick(v: unknown, re: RegExp): string | undefined {
  return typeof v === 'string' && re.test(v) ? v : undefined;
}

function enumOf(v: unknown): string | undefined {
  return typeof v === 'string' ? pick(v.toUpperCase(), ENUM_RE) : undefined;
}

function last4(v: unknown): string | undefined {
  const digits = typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\D/g, '') : '';
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * At most this many account events are read from one POST. Meta sends one
 * event per change; the cap bounds what a signed-but-misbehaving partner app
 * can turn into ops alerts in a single request.
 */
export const MAX_ACCOUNT_EVENTS_PER_POST = 10;

/** Every account event in a webhook POST (capped). Pure; garbage ⇒ []. */
export function parseMetaAccountEvents(body: unknown): MetaAccountEvent[] {
  try {
    const entries = (body as { entry?: unknown })?.entry;
    if (!Array.isArray(entries)) return [];
    const out: MetaAccountEvent[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const { changes, time: rawTime } = entry as { changes?: unknown; time?: unknown };
      if (!Array.isArray(changes)) continue;
      const time = typeof rawTime === 'number' && Number.isFinite(rawTime) ? rawTime : null;
      for (const change of changes) {
        if (!change || typeof change !== 'object') continue;
        const { field, value } = change as { field?: unknown; value?: unknown };
        if (!isMetaAccountField(field)) continue;
        if (out.length >= MAX_ACCOUNT_EVENTS_PER_POST) return out;
        const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const f = field;
        if (f === 'phone_number_quality_update') {
          out.push(defined({
            field: f, time,
            event: enumOf(v.event),
            phoneLast4: last4(v.display_phone_number),
            currentLimit: enumOf(v.current_limit),
          }));
          continue;
        }
        out.push(defined({
          field: f, time,
          templateName: pick(v.message_template_name, TEMPLATE_NAME_RE),
          templateLanguage: pick(v.message_template_language, LANG_RE),
          event: enumOf(v.event),
          reason: enumOf(v.reason),
          previousCategory: enumOf(v.previous_category),
          newCategory: enumOf(v.new_category),
          correctCategory: enumOf(v.correct_category),
        }));
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Template states a human must act on (sends with this template fail or soon will).
const TEMPLATE_ACTION_EVENTS: ReadonlySet<string> = new Set([
  'REJECTED', 'DISABLED', 'PAUSED', 'FLAGGED', 'LIMIT_EXCEEDED', 'PENDING_DELETION', 'DELETED', 'LOCKED',
]);

function tenantNote(tenantId: PartnerId): string {
  return tenantId === 'default' ? '' : ` (partner ${tenantId})`;
}

/** The ops alert for one account event: plain English, no customer data. */
export function metaAccountEventAlert(ev: MetaAccountEvent, tenantId: PartnerId): { message: string; dedupeKey: string } {
  const who = tenantNote(tenantId);
  const tpl = ev.templateName ? `"${ev.templateName}"${ev.templateLanguage ? ` (${ev.templateLanguage})` : ''}` : 'a template';
  let message: string;
  if (ev.field === 'message_template_status_update') {
    const status = ev.event ?? 'UNKNOWN';
    if (status === 'APPROVED') {
      message = `Meta approved the WhatsApp template ${tpl}${who}. It can be used now.`;
    } else if (TEMPLATE_ACTION_EVENTS.has(status)) {
      message = `Action needed: Meta marked the WhatsApp template ${tpl}${who} as ${status}${ev.reason && ev.reason !== 'NONE' ? ` (reason: ${ev.reason})` : ''}. Messages that use it will fail until it is fixed in WhatsApp Manager.`;
    } else {
      message = `Meta changed the WhatsApp template ${tpl}${who} to ${status}.`;
    }
  } else if (ev.field === 'template_category_update') {
    message = ev.correctCategory
      ? `Meta will re-label the WhatsApp template ${tpl}${who} from ${ev.newCategory ?? 'its category'} to ${ev.correctCategory} in 24 hours. Check WhatsApp Manager if that is wrong.`
      : `Meta re-labelled the WhatsApp template ${tpl}${who} from ${ev.previousCategory ?? 'its old category'} to ${ev.newCategory ?? 'a new category'}. Check WhatsApp Manager; a wrong label can change cost and block new templates.`;
  } else {
    const number = ev.phoneLast4 ? ` ending ${ev.phoneLast4}` : '';
    message = `WhatsApp number${number}${who} quality update: ${ev.event ?? 'UNKNOWN'}${ev.currentLimit ? `, messaging limit now ${ev.currentLimit}` : ''}. Check the number's status in WhatsApp Manager.`;
  }
  const subject = ev.templateName
    ? `${ev.templateName}:${ev.templateLanguage ?? ''}`
    : ev.phoneLast4 ?? '';
  const detail = ev.correctCategory ?? ev.newCategory ?? ev.event ?? '';
  // One alert per (tenant, field, template or number, outcome, hour of Meta's
  // send time): a redelivery (Meta retries until it gets a 200) never alerts
  // twice, and a signed sender varying `time` gets at most one per hour per
  // outcome. An event with no time uses the current hour.
  const when = Math.floor((ev.time !== null ? ev.time * 1000 : Date.now()) / 3_600_000);
  return { message, dedupeKey: `metaacct:${tenantId}:${ev.field}:${subject}:${detail}:${when}` };
}
