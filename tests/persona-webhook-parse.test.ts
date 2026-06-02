import { describe, it, expect } from 'vitest';
import { parsePersonaEvent } from '@/lib/providers/persona-webhook-parse';

// Envelope: top-level attrs kebab; `fields` keys snake_case (Task-0 finding).
const completed = {
  data: {
    type: 'event',
    id: 'evt_abc',
    attributes: {
      name: 'inquiry.completed',
      'created-at': '2026-06-02T20:00:00Z',
      payload: {
        data: {
          type: 'inquiry',
          id: 'inq_123',
          attributes: {
            status: 'completed',
            'reference-id': '15551230000',
            fields: { identification_number: { type: 'string', value: 'XXX-XX-6789' } },
          },
        },
      },
    },
  },
};

const declined = { data: { type: 'event', id: 'evt_dec', attributes: { name: 'inquiry.declined', 'created-at': '2026-06-02T20:01:00Z', payload: { data: { id: 'inq_123', attributes: { status: 'declined', 'reference-id': '15551230000' } } } } } };

const watchlist = { data: { type: 'event', id: 'evt_wl', attributes: { name: 'report/watchlist.matched', 'created-at': '2026-06-02T20:02:00Z', payload: { data: { id: 'rpt_1', attributes: { 'reference-id': '15551230000' } } } } } };

describe('parsePersonaEvent', () => {
  it('extracts event id, name, inquiry id, reference-id, status, idLast4', () => {
    const e = parsePersonaEvent(completed);
    expect(e).toMatchObject({ eventId: 'evt_abc', name: 'inquiry.completed', inquiryId: 'inq_123', referenceId: '15551230000', status: 'completed' });
    expect(e?.idLast4).toBe('6789');
  });

  it('flags a declined inquiry', () => {
    expect(parsePersonaEvent(declined)).toMatchObject({ name: 'inquiry.declined', status: 'declined' });
  });

  it('flags a watchlist match', () => {
    const e = parsePersonaEvent(watchlist);
    expect(e?.name).toBe('report/watchlist.matched');
    expect(e?.watchlistMatched).toBe(true);
    expect(e?.referenceId).toBe('15551230000');
  });

  it('returns null for an unparseable body', () => {
    expect(parsePersonaEvent({ nonsense: true })).toBeNull();
    expect(parsePersonaEvent(null)).toBeNull();
    expect(parsePersonaEvent('garbage')).toBeNull();
  });
});
