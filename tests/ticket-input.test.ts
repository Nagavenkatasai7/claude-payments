import { describe, it, expect } from 'vitest';
import {
  MAX_OPEN_TICKETS,
  OPEN_TICKET_STATUSES,
  TICKET_BODY_MAX,
  TICKET_BODY_MIN,
  TICKET_REPLY_MIN,
  TICKET_SUBJECT_MAX,
  TICKET_SUBJECT_MIN,
  validateNewTicket,
  validateTicketReply,
} from '@/lib/ticket-input';

// UI redesign M2-12, Task 12.2: the pure ticket validation shared by the legacy /account/support actions
// and the customer portal. The numbers are the legacy ones (support/actions.ts before the extraction).

describe('ticket-input constants (legacy parity)', () => {
  it('keeps the legacy limits', () => {
    expect([TICKET_SUBJECT_MIN, TICKET_SUBJECT_MAX]).toEqual([3, 120]);
    expect([TICKET_BODY_MIN, TICKET_BODY_MAX]).toEqual([10, 2000]);
    expect(TICKET_REPLY_MIN).toBe(1);
    expect(MAX_OPEN_TICKETS).toBe(5);
    expect([...OPEN_TICKET_STATUSES].sort()).toEqual(['open', 'pending', 'waiting_admin']);
  });
});

describe('validateNewTicket', () => {
  it('trims and accepts a valid subject and message', () => {
    expect(validateNewTicket({ subject: '  Where is it  ', message: '  My transfer is late.  ' })).toEqual({
      ok: true,
      subject: 'Where is it',
      body: 'My transfer is late.',
    });
  });
  it('refuses a short or long subject first', () => {
    expect(validateNewTicket({ subject: 'ab', message: 'x'.repeat(20) })).toEqual({ ok: false, error: 'subject' });
    expect(validateNewTicket({ subject: 'a'.repeat(121), message: 'x'.repeat(20) })).toEqual({ ok: false, error: 'subject' });
    expect(validateNewTicket({ subject: '   ab   ', message: 'x'.repeat(20) })).toEqual({ ok: false, error: 'subject' });
  });
  it('refuses a short or long message', () => {
    expect(validateNewTicket({ subject: 'Hello', message: 'short' })).toEqual({ ok: false, error: 'message' });
    expect(validateNewTicket({ subject: 'Hello', message: 'x'.repeat(2001) })).toEqual({ ok: false, error: 'message' });
  });
  it('accepts the boundaries', () => {
    expect(validateNewTicket({ subject: 'abc', message: 'x'.repeat(10) }).ok).toBe(true);
    expect(validateNewTicket({ subject: 'a'.repeat(120), message: 'x'.repeat(2000) }).ok).toBe(true);
  });
  it('treats non-strings as empty', () => {
    expect(validateNewTicket({ subject: null, message: undefined })).toEqual({ ok: false, error: 'subject' });
    expect(validateNewTicket({ subject: 'Hello', message: 42 })).toEqual({ ok: false, error: 'message' });
  });
});

describe('validateTicketReply', () => {
  it('trims and accepts 1-2000 chars', () => {
    expect(validateTicketReply(' ok ')).toEqual({ ok: true, body: 'ok' });
    expect(validateTicketReply('x'.repeat(2000)).ok).toBe(true);
  });
  it('refuses empty, blank, too long and non-strings', () => {
    for (const bad of ['', '   ', 'x'.repeat(2001), null, undefined, 5]) {
      expect(validateTicketReply(bad)).toEqual({ ok: false, error: 'message' });
    }
  });
});
