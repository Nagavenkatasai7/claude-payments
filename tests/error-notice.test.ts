// Fix pack 8 T3 (R44, P5): pure routing of a reported problem about a transfer.
// Times are relative to one `now` captured at load; no calendar dates.
import { describe, expect, it } from 'vitest';
import {
  NOTICE_DEFAULT_DELIVERY_DAYS,
  NOTICE_WINDOW_DAYS,
  REPORT_CODES,
  disclosedAvailableAt,
  insideNoticeWindow,
  isReportCode,
  reportCodeOf,
  routeReport,
  type ReportCode,
  type ReportFacts,
  type ReportRoute,
  type ReportTransfer,
} from '../src/lib/error-notice';
import { addBusinessDays } from '../src/lib/remittance-disclosure';
import { DEFAULT_DELIVERY_BUSINESS_DAYS } from '../src/lib/partner-config';
import { HUMAN_HELP_SUBJECT } from '../src/lib/ticket-category';

const now = Date.now();
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function tr(o: Partial<ReportTransfer> = {}): ReportTransfer {
  return {
    status: 'paid',
    transferType: 'b2c',
    refundStatus: 'none',
    complianceStatus: 'cleared',
    environment: 'live',
    paidAt: iso(now - 40 * MIN),
    ...o,
  };
}

function facts(o: Partial<ReportFacts> = {}): ReportFacts {
  return { transfer: tr(), snapshotDays: null, chargedAt: null, code: 'wrong_recipient', now, ...o };
}

const caseOf = (regClass: string, refundPossible: boolean, cancellable: boolean) => ({ kind: 'case', regClass, refundPossible, cancellable });

describe('routeReport (P5)', () => {
  it('1. paid minute 10 -> case error_notice, cancellable true, refundPossible false', () => {
    expect(routeReport(facts({ chargedAt: now - 10 * MIN }))).toEqual(caseOf('error_notice', false, true));
  });

  it('2. paid minute 40 -> case error_notice, refundPossible true', () => {
    expect(routeReport(facts())).toEqual(caseOf('error_notice', true, false));
  });

  it('3. paid with refund requested / pending / failed -> error_notice, refundPossible false', () => {
    for (const refundStatus of ['requested', 'pending', 'failed'] as const) {
      expect(routeReport(facts({ transfer: tr({ refundStatus }) })), refundStatus).toEqual(caseOf('error_notice', false, false));
    }
  });

  it('4. in_review -> error_notice (inside the window), refundPossible false', () => {
    expect(routeReport(facts({ transfer: tr({ status: 'in_review' }) }))).toEqual(caseOf('error_notice', false, false));
  });

  it('5. delivered 3 days ago -> error_notice', () => {
    const t = tr({ status: 'delivered', paidAt: iso(now - 4 * DAY), deliveredAt: iso(now - 3 * DAY) });
    expect(routeReport(facts({ transfer: t }))).toEqual(caseOf('error_notice', false, false));
  });

  it('6. delivered: day 179 after the disclosed date -> error_notice; day 181 -> complaint', () => {
    for (const [ago, want] of [[179, 'error_notice'], [181, 'complaint']] as const) {
      const paidMs = now - (ago + 30) * DAY;
      const delivered = now - ago * DAY;
      const t = tr({ status: 'delivered', paidAt: iso(paidMs), deliveredAt: iso(delivered) });
      const disclosed = disclosedAvailableAt(t, null);
      // deliveredAt is later than the promised date, so it is the disclosed date.
      expect(addBusinessDays(paidMs, 1).getTime()).toBeLessThan(delivered);
      expect(disclosed).toBe(delivered);
      expect(routeReport(facts({ transfer: t }))).toEqual(caseOf(want, false, false));
    }
  });

  it('7. NULL deliveryBusinessDays -> snapshot days, then the default; the row 0 wins over a snapshot', () => {
    const paidMs = now - 40 * MIN;
    const t = tr({ deliveryBusinessDays: undefined });
    expect(disclosedAvailableAt(t, 5)).toBe(addBusinessDays(paidMs, 5).getTime());
    expect(disclosedAvailableAt(t, null)).toBe(addBusinessDays(paidMs, NOTICE_DEFAULT_DELIVERY_DAYS).getTime());
    expect(disclosedAvailableAt(tr({ deliveryBusinessDays: 0 }), 5)).toBe(addBusinessDays(paidMs, 0).getTime());
    expect(disclosedAvailableAt(tr({ deliveryBusinessDays: 3 }), 5)).toBe(addBusinessDays(paidMs, 3).getTime());
  });

  it('8. deliveredAt null -> paid + days; the later of promised and delivered wins', () => {
    const paidMs = now - 10 * DAY;
    const promised = addBusinessDays(paidMs, 3).getTime();
    expect(disclosedAvailableAt(tr({ paidAt: iso(paidMs), deliveryBusinessDays: 3 }), null)).toBe(promised);
    const early = paidMs + 60 * MIN;
    expect(disclosedAvailableAt(tr({ paidAt: iso(paidMs), deliveryBusinessDays: 3, deliveredAt: iso(early) }), null)).toBe(promised);
    const late = promised + 2 * DAY;
    expect(disclosedAvailableAt(tr({ paidAt: iso(paidMs), deliveryBusinessDays: 3, deliveredAt: iso(late) }), null)).toBe(late);
    // deliveredAt alone (no paidAt) is the disclosed date
    expect(disclosedAvailableAt(tr({ paidAt: undefined, deliveredAt: iso(late) }), null)).toBe(late);
  });

  it('9. both times null -> complaint; disclosedAvailableAt null; insideNoticeWindow false', () => {
    const t = tr({ status: 'delivered', paidAt: undefined, deliveredAt: undefined });
    expect(disclosedAvailableAt(t, 5)).toBeNull();
    expect(insideNoticeWindow(t, 5, now)).toBe(false);
    expect(routeReport(facts({ transfer: t }))).toEqual(caseOf('complaint', false, false));
    // unparseable times count as absent
    const bad = tr({ status: 'delivered', paidAt: 'not-a-date', deliveredAt: 'nope' });
    expect(disclosedAvailableAt(bad, null)).toBeNull();
    expect(routeReport(facts({ transfer: bad }))).toEqual(caseOf('complaint', false, false));
  });

  it('insideNoticeWindow is inclusive at exactly 180 calendar days', () => {
    const t = tr({ status: 'delivered', paidAt: undefined, deliveredAt: iso(now - NOTICE_WINDOW_DAYS * DAY) });
    expect(NOTICE_WINDOW_DAYS).toBe(180);
    expect(insideNoticeWindow(t, null, now)).toBe(true);
    expect(insideNoticeWindow(t, null, now + 1)).toBe(false);
  });

  it('10. cancelled / refund completed / blocked / awaiting_payment -> complaint, refundPossible false', () => {
    const rows: ReportTransfer[] = [
      tr({ status: 'cancelled' }),
      tr({ refundStatus: 'completed' }),
      tr({ status: 'blocked' }),
      tr({ status: 'awaiting_payment', paidAt: undefined }),
      tr({ status: 'awaiting_payment' }),
    ];
    for (const t of rows) expect(routeReport(facts({ transfer: t })), JSON.stringify(t)).toEqual(caseOf('complaint', false, false));
  });

  it('11. unauthorized on each status -> fraud_report', () => {
    const u = (o: Partial<ReportFacts>) => routeReport(facts({ code: 'unauthorized', ...o }));
    expect(u({ chargedAt: now - 10 * MIN })).toEqual(caseOf('fraud_report', false, true));
    expect(u({})).toEqual(caseOf('fraud_report', true, false));
    const others: ReportTransfer[] = [
      tr({ status: 'in_review' }),
      tr({ status: 'delivered', deliveredAt: iso(now - DAY) }),
      tr({ status: 'delivered', paidAt: iso(now - 400 * DAY), deliveredAt: iso(now - 399 * DAY) }),
      tr({ status: 'cancelled' }),
      tr({ status: 'blocked' }),
      tr({ status: 'awaiting_payment', paidAt: undefined }),
      tr({ refundStatus: 'completed' }),
      tr({ refundStatus: 'requested' }),
      tr({ refundStatus: 'pending' }),
    ];
    for (const t of others) expect(u({ transfer: t }), JSON.stringify(t)).toEqual(caseOf('fraud_report', false, false));
  });

  it('12. b2b and test rows -> not_consumer, also with code unauthorized', () => {
    for (const code of ['wrong_amount', 'unauthorized'] as const) {
      expect(routeReport(facts({ code, transfer: tr({ transferType: 'b2b' }) }))).toEqual({ kind: 'not_consumer' });
      expect(routeReport(facts({ code, transfer: tr({ environment: 'test' }) }))).toEqual({ kind: 'not_consumer' });
      expect(routeReport(facts({ code, chargedAt: now - 5 * MIN, transfer: tr({ environment: 'test' }) }))).toEqual({ kind: 'not_consumer' });
    }
  });

  it('13. complianceStatus is never read', () => {
    const shapes: Array<Partial<ReportFacts>> = [
      { chargedAt: now - 10 * MIN },
      {},
      { transfer: tr({ status: 'in_review' }) },
      { transfer: tr({ status: 'blocked' }) },
      { code: 'unauthorized' },
    ];
    for (const s of shapes) {
      const base = s.transfer ?? tr();
      const routes = (['cleared', 'blocked', 'flagged'] as const).map((complianceStatus) =>
        routeReport(facts({ ...s, transfer: { ...base, complianceStatus } })),
      );
      expect(routes[1]).toEqual(routes[0]);
      expect(routes[2]).toEqual(routes[0]);
    }
  });

  it('14. the route type has no refusal arm; REPORT_CODES is closed and frozen', () => {
    const describeRoute = (r: ReportRoute): string => {
      switch (r.kind) {
        case 'case':
          return r.regClass;
        case 'not_consumer':
          return 'none';
        default: {
          const never: never = r;
          return never;
        }
      }
    };
    expect(describeRoute(routeReport(facts()))).toBe('error_notice');
    expect(REPORT_CODES).toEqual(['wrong_recipient', 'wrong_amount', 'not_received', 'unauthorized', 'other', 'complaint', 'cancellation']);
    expect(Object.isFrozen(REPORT_CODES)).toBe(true);
    for (const c of REPORT_CODES) expect(isReportCode(c)).toBe(true);
    for (const v of ['__proto__', 'toString', 'constructor', '', 'Other', null, undefined, 1, {}]) expect(isReportCode(v)).toBe(false);
  });

  it('every code routes to a case (a report is never refused)', () => {
    for (const code of REPORT_CODES) {
      const r = routeReport(facts({ code }));
      expect(r.kind).toBe('case');
    }
  });
});

describe('reportCodeOf (P5, DP6)', () => {
  it('15. reads the fixed subject first, then the class', () => {
    expect(reportCodeOf({ regClass: 'error_notice', subject: 'Recall request: wrong_amount' })).toBe('wrong_amount');
    expect(reportCodeOf({ regClass: null, subject: 'Recall request: not_received' })).toBe('not_received');
    expect(reportCodeOf({ regClass: 'error_notice', subject: 'Recall request: nonsense' })).toBe('other');
    expect(reportCodeOf({ regClass: 'error_notice', subject: 'Recall request: __proto__' })).toBe('other');
    expect(reportCodeOf({ regClass: 'complaint', subject: HUMAN_HELP_SUBJECT })).toBe('complaint');
    expect(reportCodeOf({ regClass: 'fraud_report', subject: HUMAN_HELP_SUBJECT })).toBe('unauthorized');
    expect(reportCodeOf({ regClass: 'cancellation', subject: HUMAN_HELP_SUBJECT })).toBe('cancellation');
    expect(reportCodeOf({ regClass: null, subject: 'random words' })).toBe('other');
    expect(reportCodeOf({ regClass: undefined, subject: 'random words' })).toBe('other');
    const c: ReportCode = reportCodeOf({ regClass: 'error_notice', subject: 'x' });
    expect(c).toBe('other');
  });
});

describe('constants', () => {
  it("16. NOTICE_DEFAULT_DELIVERY_DAYS equals partner-config's DEFAULT_DELIVERY_BUSINESS_DAYS", () => {
    expect(NOTICE_DEFAULT_DELIVERY_DAYS).toBe(DEFAULT_DELIVERY_BUSINESS_DAYS);
  });
});
