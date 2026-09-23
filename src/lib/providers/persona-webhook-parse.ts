/**
 * persona-webhook-parse — pure, defensive Persona webhook → PersonaEvent (Phase 2, Task 5).
 *
 * Envelope (kebab top-level attrs; `fields` keys snake_case — Task-0 finding):
 *   { data: { id: <evt_…>, attributes: {
 *       name: 'inquiry.completed', 'created-at': '…',
 *       payload: { data: { id: <inq_…>, attributes: { status, 'reference-id', fields } } } } } }
 *
 * Program-Fix 35 — REPORT events (`report/<kind>.<verb>`): `payload.data` is the
 * REPORT object, not an inquiry (https://docs.withpersona.com/api-reference/reports/retrieve-a-report):
 *   { type: 'report/<kind>', id: <rep_…>, attributes: { status, … },
 *     relationships: { inquiry: { data: { type: 'inquiry', id: <inq_…> } }, … } }
 * It carries no phone, so `referenceId` is always null for a report and the
 * route binds the customer by `inquiryId` (the relationship) alone. The `rep_`
 * id is kept apart in `reportId` and must never be stored as the inquiry id.
 * Event names: https://docs.withpersona.com/events (every `report/*.matched`,
 * e.g. `report/politically-exposed-person.matched`, `report/watchlist.matched`).
 *
 * Never throws — an unparseable body returns null so the route can 200-ignore it.
 */

/** A `report/*.matched` event's kind: pep and watchlist set flags; every other match only holds. */
export type PersonaMatchKind = 'watchlist' | 'pep' | 'other';

export interface PersonaEvent {
  eventId: string;
  name: string; // 'inquiry.created' | 'inquiry.started' | 'inquiry.completed' | 'inquiry.approved'
  //            | 'inquiry.declined' | 'inquiry.failed' | 'inquiry.marked-for-review'
  //            | 'inquiry.expired' | 'inquiry.transitioned' | 'report/watchlist.matched' | …
  createdAt: string; // ISO — order events by this when reconciling out-of-order delivery
  inquiryId: string | null;
  referenceId: string | null;
  status: string | null;
  idLast4?: string;
  watchlistMatched?: boolean;
  /** Program-Fix 35: the `rep_…` id of a report event (never an inquiry id). */
  reportId?: string;
  /** Program-Fix 35: set only for a `report/*.matched` event. */
  matchKind?: PersonaMatchKind;
}

const WATCHLIST_KINDS = new Set(['watchlist', 'business-watchlist']);
const PEP_KINDS = new Set(['politically-exposed-person']);

/** `report/<kind>.matched` → its match kind; anything else → undefined. */
export function reportMatchKind(name: string): PersonaMatchKind | undefined {
  if (!name.startsWith('report/') || !name.endsWith('.matched')) return undefined;
  const kind = name.slice('report/'.length, -'.matched'.length);
  if (PEP_KINDS.has(kind)) return 'pep';
  if (WATCHLIST_KINDS.has(kind)) return 'watchlist';
  return 'other';
}

/** True for any Persona report event (by name, or by the payload object's type). */
export function isReportEventName(name: string): boolean {
  return name.startsWith('report/');
}

function digitsLast4(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const d = v.replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : undefined;
}

export function parsePersonaEvent(body: unknown): PersonaEvent | null {
  try {
    const b = body as any;
    const attrs = b?.data?.attributes;
    const name = attrs?.name;
    const eventId = b?.data?.id;
    if (!name || !eventId) return null;

    const obj = attrs?.payload?.data;

    // Program-Fix 35: a report event binds by its inquiry relationship only.
    const objType = typeof obj?.type === 'string' ? obj.type : '';
    if (isReportEventName(name) || objType.startsWith('report/')) {
      const rel = obj?.relationships?.inquiry?.data?.id;
      const matchKind = reportMatchKind(name);
      const reportId = typeof obj?.id === 'string' ? obj.id : undefined;
      return {
        eventId,
        name,
        createdAt: attrs?.['created-at'] ?? '',
        inquiryId: typeof rel === 'string' && rel !== '' ? rel : null,
        referenceId: null,
        status: obj?.attributes?.status ?? null,
        ...(reportId ? { reportId } : {}),
        ...(matchKind ? { matchKind } : {}),
        watchlistMatched: matchKind === 'watchlist' ? true : undefined,
      };
    }

    const inq = obj;
    const iAttrs = inq?.attributes ?? {};

    // NB (Task-0): `fields` keys are snake_case; the exact id-number key is
    // unconfirmed until a COMPLETED sandbox inquiry. Try the likely candidates;
    // idLast4 is display-only so an undefined result degrades gracefully.
    const f = iAttrs?.fields ?? {};
    const idField =
      f?.identification_number?.value ??
      f?.current_government_id?.value?.identification_number ??
      f?.government_id_number?.value ??
      iAttrs?.['identification-number'];

    return {
      eventId,
      name,
      createdAt: attrs?.['created-at'] ?? '',
      inquiryId: inq?.id ?? null,
      referenceId: iAttrs?.['reference-id'] ?? null,
      status: iAttrs?.status ?? null,
      idLast4: digitsLast4(idField),
    };
  } catch {
    return null;
  }
}
