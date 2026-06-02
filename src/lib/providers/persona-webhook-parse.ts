/**
 * persona-webhook-parse — pure, defensive Persona webhook → PersonaEvent (Phase 2, Task 5).
 *
 * Envelope (kebab top-level attrs; `fields` keys snake_case — Task-0 finding):
 *   { data: { id: <evt_…>, attributes: {
 *       name: 'inquiry.completed', 'created-at': '…',
 *       payload: { data: { id: <inq_…>, attributes: { status, 'reference-id', fields } } } } } }
 *
 * Never throws — an unparseable body returns null so the route can 200-ignore it.
 */

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

    const inq = attrs?.payload?.data;
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
      watchlistMatched: name === 'report/watchlist.matched' ? true : undefined,
    };
  } catch {
    return null;
  }
}
