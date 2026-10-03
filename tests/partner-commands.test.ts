import { describe, it, expect } from 'vitest';
import { KNOWN_PARTNER_ROLES, type PartnerRole } from '@/lib/partner-access';
import { PARTNER_ROUTES, routeAllows, type PartnerRouteKey } from '@/app/partner/routes';
import { buildPartnerCommands, openCommandScope, openCommands } from '@/lib/partner-commands';
import { isTransferId } from '@/lib/partner-transfers';
import { isTicketId } from '@/lib/partner-tickets';

// Lost-features A16: the /partner command palette. Its "Go to" items come from the ONE route table,
// so it can never offer a page the role cannot open; the "Open" items appear only for a well-formed
// id and a role that may open that kind of page (the detail page re-gates and 404s a foreign id).
const keyOf = (href: string) =>
  (Object.keys(PARTNER_ROUTES) as PartnerRouteKey[]).find((k) => PARTNER_ROUTES[k].href === href);

describe('buildPartnerCommands', () => {
  it.each(KNOWN_PARTNER_ROLES)('%s: every item is a route the role may open', (role) => {
    const items = buildPartnerCommands(role);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      const key = keyOf(it.href);
      expect(key, it.href).toBeDefined();
      expect(routeAllows(key!, role)).toBe(true);
    }
    // ids are unique (React keys and aria-activedescendant targets)
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('every route the role may open is offered, except the bare conversation path', () => {
    for (const role of KNOWN_PARTNER_ROLES) {
      const hrefs = new Set(buildPartnerCommands(role).map((i) => i.href));
      for (const key of Object.keys(PARTNER_ROUTES) as PartnerRouteKey[]) {
        const want = routeAllows(key, role) && key !== 'customerConversation';
        expect(hrefs.has(PARTNER_ROUTES[key].href), `${role} ${key}`).toBe(want);
      }
    }
  });

  it('new customer and invoices are admin only; support gets no money pages', () => {
    const has = (role: PartnerRole, key: PartnerRouteKey) => buildPartnerCommands(role).some((i) => i.href === PARTNER_ROUTES[key].href);
    expect(has('admin', 'customersNew')).toBe(true);
    expect(has('admin', 'invoices')).toBe(true);
    for (const role of ['agent', 'support', 'finance'] as const) {
      expect(has(role, 'customersNew')).toBe(false);
      expect(has(role, 'invoices')).toBe(false);
    }
    for (const key of ['transfers', 'refunds', 'schedules', 'reports', 'analytics'] as const) expect(has('support', key)).toBe(false);
  });

  it('an unknown role gets nothing', () => {
    expect(buildPartnerCommands('owner' as PartnerRole)).toEqual([]);
  });

  it('labels are the route labels; hrefs carry no query string', () => {
    for (const it of buildPartnerCommands('admin')) {
      expect(it.label.length).toBeGreaterThan(0);
      expect(it.href).not.toContain('?');
    }
  });
});

describe('openCommandScope + openCommands', () => {
  const TRANSFER = 'Xk3_pQ9vLm2aB7cD1eF0gw';
  const TICKET = 'tk_Xk3_pQ9vLm2aB7cD1eF0gw';

  it('the scope follows the route table', () => {
    expect(openCommandScope('admin')).toEqual({ transfers: true, tickets: true });
    expect(openCommandScope('agent')).toEqual({ transfers: true, tickets: true });
    expect(openCommandScope('support')).toEqual({ transfers: false, tickets: true });
    expect(openCommandScope('finance')).toEqual({ transfers: true, tickets: false });
    expect(openCommandScope('owner' as PartnerRole)).toEqual({ transfers: false, tickets: false });
  });

  it('a transfer id offers "Open transfer" for a money role only', () => {
    const [cmd] = openCommands(TRANSFER, { transfers: true, tickets: true });
    expect(cmd).toMatchObject({ kind: 'transfer', id: TRANSFER, href: `/partner/transfers/${TRANSFER}` });
    expect(openCommands(TRANSFER, { transfers: false, tickets: true })).toEqual([]);
  });

  it('a tk_ id offers "Open ticket" only (never a transfer), for a ticket role only', () => {
    expect(openCommands(TICKET, { transfers: true, tickets: true })).toEqual([
      { kind: 'ticket', id: TICKET, href: `/partner/support/${TICKET}` },
    ]);
    expect(openCommands(TICKET, { transfers: true, tickets: false })).toEqual([]);
  });

  it('trims the query; a word, a phrase or a path is never offered as an id', () => {
    expect(openCommands(`  ${TRANSFER} `, { transfers: true, tickets: true })[0]?.id).toBe(TRANSFER);
    for (const q of ['', 'transfers', 'refunds', 'open transfer', '../admin', 'a/b', 'x?y=1', 'tk_', 'tk_a b']) {
      expect(openCommands(q, { transfers: true, tickets: true }), q).toEqual([]);
    }
  });

  it('an old 8-character id (with a digit) is offered', () => {
    expect(openCommands('ab12cd34', { transfers: true, tickets: false })[0]?.id).toBe('ab12cd34');
  });

  it('a typed phone number is never offered (it would land in the URL)', () => {
    for (const q of ['15551234567', '+15551234567', '5551234', '12345678', '4155550101', '1'.repeat(22), 'abc123', 'abcdefgh']) {
      expect(openCommands(q, { transfers: true, tickets: true }), q).toEqual([]);
    }
  });

  it('never offers an id the detail pages would refuse', () => {
    for (const q of [TRANSFER, 'ab12cd34', 'x'.repeat(64) + '1', TICKET, 'tk_' + 'y'.repeat(78)]) {
      for (const c of openCommands(q, { transfers: true, tickets: true })) {
        expect(c.kind === 'transfer' ? isTransferId(c.id) : isTicketId(c.id), q).toBe(true);
      }
    }
  });
});
