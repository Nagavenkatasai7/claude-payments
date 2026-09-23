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

  it('flags a watchlist match; a report event never reads reference-id as the phone (Program-Fix 35)', () => {
    const e = parsePersonaEvent(watchlist);
    expect(e?.name).toBe('report/watchlist.matched');
    expect(e?.watchlistMatched).toBe(true);
    expect(e?.matchKind).toBe('watchlist');
    // The customer binds through the inquiry relationship, never a report attribute.
    expect(e?.referenceId).toBeNull();
    expect(e?.reportId).toBe('rpt_1');
    expect(e?.inquiryId).toBeNull(); // this legacy fixture carries no relationships
  });

  it('returns null for an unparseable body', () => {
    expect(parsePersonaEvent({ nonsense: true })).toBeNull();
    expect(parsePersonaEvent(null)).toBeNull();
    expect(parsePersonaEvent('garbage')).toBeNull();
  });
});

// Program-Fix 35: a report event's payload.data is the REPORT object — type
// 'report/<kind>', id 'rep_…', and the inquiry under relationships.inquiry.data.id
// (https://docs.withpersona.com/api-reference/reports/retrieve-a-report). It
// has no phone. Event names: https://docs.withpersona.com/events.
const reportEvent = (name: string, over: Record<string, unknown> = {}) => ({
  data: {
    type: 'event',
    id: `evt_${name}`,
    attributes: {
      name,
      'created-at': '2026-06-02T20:03:00Z',
      payload: {
        data: {
          type: `report/${name.slice('report/'.length).split('.')[0]}`,
          id: 'rep_ABC',
          attributes: { status: 'ready', 'created-at': '2026-06-02T20:03:00Z' },
          relationships: {
            inquiry: { data: { type: 'inquiry', id: 'inq_XYZ' } },
            account: { data: { type: 'account', id: 'act_1' } },
          },
          ...over,
        },
      },
    },
  },
});

describe('parsePersonaEvent — report events (Program-Fix 35)', () => {
  it('PEP matched gives matchKind pep, inquiryId from relationships, never the rep_ id', () => {
    const e = parsePersonaEvent(reportEvent('report/politically-exposed-person.matched'));
    expect(e).toMatchObject({
      name: 'report/politically-exposed-person.matched',
      matchKind: 'pep',
      inquiryId: 'inq_XYZ',
      reportId: 'rep_ABC',
      referenceId: null,
    });
    expect(e?.watchlistMatched).toBeUndefined();
    expect(e?.idLast4).toBeUndefined();
  });

  it('watchlist and business-watchlist matches are the watchlist kind', () => {
    for (const n of ['report/watchlist.matched', 'report/business-watchlist.matched']) {
      const e = parsePersonaEvent(reportEvent(n));
      expect(e?.matchKind).toBe('watchlist');
      expect(e?.watchlistMatched).toBe(true);
      expect(e?.inquiryId).toBe('inq_XYZ');
    }
  });

  it('any other *.matched report is the other kind', () => {
    for (const n of ['report/adverse-media.matched', 'report/screening.matched', 'report/custom-list.matched', 'report/crypto-address-watchlist.matched']) {
      const e = parsePersonaEvent(reportEvent(n));
      expect(e?.matchKind, n).toBe('other');
      expect(e?.watchlistMatched, n).toBeUndefined();
    }
  });

  it('.ready / .dismissed / .errored (and screening.reviewed) carry no matchKind', () => {
    for (const n of [
      'report/politically-exposed-person.ready',
      'report/politically-exposed-person.dismissed',
      'report/politically-exposed-person.errored',
      'report/watchlist.dismissed',
      'report/screening.reviewed',
    ]) {
      const e = parsePersonaEvent(reportEvent(n));
      expect(e?.matchKind, n).toBeUndefined();
      expect(e?.watchlistMatched, n).toBeUndefined();
      expect(e?.inquiryId, n).toBe('inq_XYZ');
      expect(e?.reportId, n).toBe('rep_ABC');
    }
  });

  it('a report event whose payload lacks a type is still read as a report (name prefix)', () => {
    const e = parsePersonaEvent(reportEvent('report/politically-exposed-person.matched', { type: undefined }));
    expect(e?.matchKind).toBe('pep');
    expect(e?.inquiryId).toBe('inq_XYZ');
    expect(e?.reportId).toBe('rep_ABC');
  });

  it('a report with a reference-id attribute still never exposes it as referenceId', () => {
    const e = parsePersonaEvent(
      reportEvent('report/watchlist.matched', { attributes: { status: 'ready', 'reference-id': '15550000000' } }),
    );
    expect(e?.referenceId).toBeNull();
  });

  it('a report with no inquiry relationship has a null inquiryId', () => {
    const e = parsePersonaEvent(reportEvent('report/watchlist.matched', { relationships: {} }));
    expect(e?.inquiryId).toBeNull();
    expect(e?.reportId).toBe('rep_ABC');
  });

  it('inquiry events keep today\'s mapping and carry no reportId / matchKind', () => {
    const e = parsePersonaEvent(completed);
    expect(e?.reportId).toBeUndefined();
    expect(e?.matchKind).toBeUndefined();
  });
});
