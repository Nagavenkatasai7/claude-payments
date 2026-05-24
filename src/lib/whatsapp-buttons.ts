export const BUTTON_LABEL_MAX = 20;
export const MAX_BUTTONS = 3;

const ELLIPSIS = '…';

export function truncateLabel(name: string): string {
  if (name.length <= BUTTON_LABEL_MAX) return name;
  // Reserve slots so the total length is BUTTON_LABEL_MAX - 2 chars of name
  // plus a single ellipsis (18 chars total when BUTTON_LABEL_MAX === 20).
  return name.slice(0, BUTTON_LABEL_MAX - 3) + ELLIPSIS;
}

export function disambiguateNames(
  recipients: { name: string; recipientPhone: string }[],
): string[] {
  const nameCounts = new Map<string, number>();
  for (const r of recipients) {
    nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1);
  }
  return recipients.map((r) => {
    if ((nameCounts.get(r.name) ?? 0) > 1) {
      const suffix = r.recipientPhone.slice(-4);
      return `${r.name} (${ELLIPSIS}${suffix})`;
    }
    return r.name;
  });
}

export function recipientButtonId(recipientPhone: string): string {
  return `recipient:${recipientPhone}`;
}

export function someoneNewButtonId(): string {
  return 'recipient:new';
}

export function approveButtonId(draftId: string): string {
  return `approve:${draftId}`;
}

export function cancelButtonId(draftId: string): string {
  return `cancel:${draftId}`;
}

export type ParsedButtonId =
  | { kind: 'recipient'; recipientPhone: string }
  | { kind: 'recipient_new' }
  | { kind: 'approve'; draftId: string }
  | { kind: 'cancel'; draftId: string };

// Allow only safe characters in payload portions.
const PHONE_RE = /^\d{6,20}$/;
const DRAFT_RE = /^[A-Za-z0-9]{4,32}$/;

export function parseButtonId(id: string): ParsedButtonId | null {
  if (!id || id.includes('\n') || id.includes('\r')) return null;
  const colon = id.indexOf(':');
  if (colon < 0) return null;
  const prefix = id.slice(0, colon);
  const payload = id.slice(colon + 1);

  if (prefix === 'recipient') {
    if (payload === 'new') return { kind: 'recipient_new' };
    if (PHONE_RE.test(payload)) return { kind: 'recipient', recipientPhone: payload };
    return null;
  }
  if (prefix === 'approve' && DRAFT_RE.test(payload)) {
    return { kind: 'approve', draftId: payload };
  }
  if (prefix === 'cancel' && DRAFT_RE.test(payload)) {
    return { kind: 'cancel', draftId: payload };
  }
  return null;
}
