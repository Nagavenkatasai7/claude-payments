import type { MessageKey } from '@/lib/i18n';
import type { ChannelHealthItem, ChannelHealthSummary, ChannelTestResult } from '@/lib/channel-health';
import type { WhatsappConfigErrorCode, WhatsappConfigForm } from '@/lib/partner-whatsapp-config';

// partner-whatsapp-view (UI redesign M3-13): the PURE half of /partner/integrations/whatsapp.
//  - parseWhatsappForm: validation at the edge. Meta ids are digits only (the same shapes the
//    Graph probe accepts, partner-integrations-verify.ts), secrets are bounded printable ASCII with
//    no whitespace. A refusal names the FIELD only, never echoes a value. Tenant fields are never read.
//  - the display projections: the phone number id's last 4, health by kind through i18n keys (the
//    channel-health summary's English text is never rendered), the last test result (status only).

export const WA_SECRET_MAX = 1024;
const PNID_RE = /^\d{5,20}$/;
const WABA_RE = /^\d{1,30}$/;
const SECRET_RE = /^[\x21-\x7E]*$/;

export type WhatsappFormField = keyof WhatsappConfigForm;
export type ParsedWhatsappForm = { ok: true; form: WhatsappConfigForm } | { ok: false; field: WhatsappFormField };

const FIELDS: readonly WhatsappFormField[] = ['phoneNumberId', 'wabaId', 'token', 'verifyToken', 'appSecret'];

function valid(field: WhatsappFormField, v: string): boolean {
  if (v === '') return true;
  if (field === 'phoneNumberId') return PNID_RE.test(v);
  if (field === 'wabaId') return WABA_RE.test(v);
  return v.length <= WA_SECRET_MAX && SECRET_RE.test(v);
}

export function parseWhatsappForm(formData: FormData): ParsedWhatsappForm {
  const out: WhatsappConfigForm = { phoneNumberId: '', token: '', verifyToken: '', appSecret: '', wabaId: '' };
  for (const field of FIELDS) {
    const raw = formData.get(field);
    if (raw !== null && typeof raw !== 'string') return { ok: false, field };
    // Bound before trimming, so an oversized value is never copied around.
    if (raw !== null && raw.length > WA_SECRET_MAX + 64) return { ok: false, field };
    const v = (raw ?? '').trim();
    if (!valid(field, v)) return { ok: false, field };
    out[field] = v;
  }
  return { ok: true, form: out };
}

export const WA_FIELD_ERROR_KEY: Readonly<Record<WhatsappFormField, MessageKey>> = Object.freeze({
  phoneNumberId: 'partner.whatsapp.error.phoneNumberId',
  wabaId: 'partner.whatsapp.error.wabaId',
  token: 'partner.whatsapp.error.secret',
  verifyToken: 'partner.whatsapp.error.secret',
  appSecret: 'partner.whatsapp.error.secret',
});

const LIB_ERROR_KEY: Readonly<Record<WhatsappConfigErrorCode, MessageKey>> = Object.freeze({
  number_unavailable: 'partner.whatsapp.error.numberUnavailable',
  unverified: 'partner.whatsapp.error.unverified',
  incomplete: 'partner.whatsapp.error.incomplete',
});

/** The fixed copy for each of the lib's refusals (never the lib's English message). */
export function waErrorKey(code: WhatsappConfigErrorCode): MessageKey {
  return LIB_ERROR_KEY[code];
}

/** The routing id is not a secret, but the page shows only its last 4 (M3-13 plan). */
export function maskPnid(pnid: string | undefined): string | null {
  if (!pnid) return null;
  return `••••${pnid.slice(-4)}`;
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const KIND_KEY: Readonly<Record<ChannelHealthItem['kind'], MessageKey>> = Object.freeze({
  auth_error: 'partner.whatsapp.health.kind.auth_error',
  dead_send: 'partner.whatsapp.health.kind.dead_send',
  incomplete_config: 'partner.whatsapp.health.kind.incomplete_config',
  sig_fail: 'partner.whatsapp.health.kind.sig_fail',
  no_phone: 'partner.whatsapp.health.kind.no_phone',
  delivery_failed: 'partner.whatsapp.health.kind.delivery_failed',
  config_warning: 'partner.whatsapp.health.kind.config_warning',
});

export interface HealthItemView {
  kind: ChannelHealthItem['kind'];
  level: 'warn' | 'error';
  labelKey: MessageKey;
  when?: string;
  count?: number;
}

export function healthItemsView(summary: Pick<ChannelHealthSummary, 'level' | 'items'>): {
  state: ChannelHealthSummary['level'];
  items: HealthItemView[];
} {
  return {
    state: summary.level,
    items: summary.items.map((i) => ({
      kind: i.kind,
      level: i.level,
      labelKey: KIND_KEY[i.kind],
      ...(i.at ? { when: when(i.at) } : {}),
      ...(i.count && i.count > 1 ? { count: i.count } : {}),
    })),
  };
}

export function testResultView(r: ChannelTestResult | null): { key: MessageKey; vars?: Record<string, string | number>; ok?: boolean } {
  if (!r) return { key: 'partner.whatsapp.test.never' };
  if (r.ok) return { key: 'partner.whatsapp.test.passed', vars: { when: when(r.at) }, ok: true };
  if (r.reason === 'not_configured') return { key: 'partner.whatsapp.test.notConfigured', vars: { when: when(r.at) }, ok: false };
  if (r.status !== undefined) return { key: 'partner.whatsapp.test.failedStatus', vars: { when: when(r.at), status: r.status }, ok: false };
  return { key: 'partner.whatsapp.test.failed', vars: { when: when(r.at) }, ok: false };
}
