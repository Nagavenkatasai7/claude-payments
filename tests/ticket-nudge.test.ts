import { describe, it, expect } from 'vitest';
import { ticketReplyNudge, ticketResolvedNudge } from '@/lib/ticket-nudge';

// Lost-features p4 C4: the WhatsApp nudges a ticket reply or resolve sends. One neutral text for
// both dashboards: the message comes from the partner's own number and the link opens the partner's
// portal, so it never names "SmartRemit" or a "dashboard".
const URL = 'https://acme.smartremit.ai/support/tk_abc';

describe('ticket nudges', () => {
  it('neither text names SmartRemit or a dashboard', () => {
    for (const s of [ticketReplyNudge(URL), ticketResolvedNudge(URL)]) {
      expect(s).not.toMatch(/smartremit dashboard|dashboard/i);
      expect(s.replace(URL, '')).not.toMatch(/smartremit/i);
    }
  });
  it('the link is appended once, at the end', () => {
    for (const s of [ticketReplyNudge(URL), ticketResolvedNudge(URL)]) {
      expect(s.split(URL)).toHaveLength(2);
      expect(s.endsWith(URL)).toBe(true);
    }
  });
  it('the reply and resolve texts say what happened', () => {
    expect(ticketReplyNudge(URL)).toMatch(/new reply/i);
    expect(ticketResolvedNudge(URL)).toMatch(/resolved/i);
  });
});
