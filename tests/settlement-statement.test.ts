import { describe, it, expect } from 'vitest';
import {
  decodeStatementCursor,
  encodeStatementCursor,
  parseStatementQuery,
  statementRow,
  statementTotals,
  toCsv,
  STATEMENT_COLUMNS,
  type SettledTransfer,
} from '@/lib/settlement-statement';

// Program-Fix 31 PR A (rail-11): the pure half of the partner settlements
// statement — query parsing, the row projection, page totals and CSV.

// A fixed clock: never the real one (CLAUDE.md: no time-window fixtures on
// the wall clock).
const NOW = new Date('2026-09-23T15:30:00.000Z');

function ok(q: Record<string, string | null | undefined>) {
  const r = parseStatementQuery(q, NOW);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.query;
}
function bad(q: Record<string, string | null | undefined>) {
  const r = parseStatementQuery(q, NOW);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
}

describe('parseStatementQuery', () => {
  it('defaults to yesterday 00:00 UTC → today 00:00 UTC, limit 100, json, no cursor', () => {
    const q = ok({});
    expect(q.from.toISOString()).toBe('2026-09-22T00:00:00.000Z');
    expect(q.to.toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(q.limit).toBe(100);
    expect(q.format).toBe('json');
    expect(q.cursor).toBeNull();
  });

  it('accepts date-only values as UTC midnight', () => {
    const q = ok({ from: '2026-09-01', to: '2026-09-08' });
    expect(q.from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(q.to.toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });

  it('accepts datetimes with Z, with an offset, and with no zone (UTC)', () => {
    expect(ok({ from: '2026-09-01T10:00:00Z', to: '2026-09-02T00:00:00Z' }).from.toISOString()).toBe(
      '2026-09-01T10:00:00.000Z',
    );
    expect(ok({ from: '2026-09-01T10:00:00+05:30', to: '2026-09-02' }).from.toISOString()).toBe(
      '2026-09-01T04:30:00.000Z',
    );
    expect(ok({ from: '2026-09-01T10:00', to: '2026-09-02' }).from.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(ok({ from: '2026-09-01T10:00:00.250Z', to: '2026-09-02' }).from.toISOString()).toBe(
      '2026-09-01T10:00:00.250Z',
    );
  });

  it('with only one bound, the other is one day away', () => {
    const a = ok({ from: '2026-09-01' });
    expect(a.to.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    const b = ok({ to: '2026-09-10' });
    expect(b.from.toISOString()).toBe('2026-09-09T00:00:00.000Z');
  });

  it('rejects malformed and impossible dates', () => {
    expect(bad({ from: 'yesterday' })).toMatch(/from/);
    expect(bad({ from: '2026-02-30' })).toMatch(/from/);
    expect(bad({ to: '2026-13-01' })).toMatch(/to/);
    expect(bad({ from: '2026-09-01T25:00:00Z' })).toMatch(/from/);
    expect(bad({ from: '1693526400' })).toMatch(/from/);
  });

  it('rejects to <= from', () => {
    expect(bad({ from: '2026-09-02', to: '2026-09-02' })).toMatch(/after/);
    expect(bad({ from: '2026-09-03', to: '2026-09-02' })).toMatch(/after/);
  });

  it('allows exactly 31 days and rejects anything longer', () => {
    expect(ok({ from: '2026-08-01', to: '2026-09-01' }).to.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(bad({ from: '2026-08-01', to: '2026-09-01T00:00:00.001Z' })).toMatch(/31 days/);
  });

  it('limit: integer 1–500, anything else is 400', () => {
    expect(ok({ limit: '1' }).limit).toBe(1);
    expect(ok({ limit: '500' }).limit).toBe(500);
    expect(bad({ limit: '0' })).toMatch(/limit/);
    expect(bad({ limit: '501' })).toMatch(/limit/);
    expect(bad({ limit: '2.5' })).toMatch(/limit/);
    expect(bad({ limit: 'ten' })).toMatch(/limit/);
  });

  it('format: json | csv only', () => {
    expect(ok({ format: 'csv' }).format).toBe('csv');
    expect(ok({ format: 'json' }).format).toBe('json');
    expect(bad({ format: 'xml' })).toMatch(/format/);
  });

  it('ignores unknown keys, including partner_id (the partner comes from the key only)', () => {
    const q = ok({ partner_id: 'globex', partnerId: 'globex' });
    expect(q).not.toHaveProperty('partnerId');
    expect(q).not.toHaveProperty('partner_id');
  });

  it('decodes a well-formed cursor and keeps the Postgres text verbatim (µs intact)', () => {
    const c = encodeStatementCursor('2026-09-22 10:00:00.123456+00', 'abcDEF_-123');
    const q = ok({ cursor: c });
    expect(q.cursor).toEqual({ paidAtText: '2026-09-22 10:00:00.123456+00', id: 'abcDEF_-123' });
  });

  it('rejects a malformed cursor with 400 (never reaches the ::timestamptz cast)', () => {
    expect(bad({ cursor: 'not-a-cursor' })).toMatch(/cursor/);
    expect(bad({ cursor: Buffer.from('2026-09-22|x').toString('base64url') })).toMatch(/cursor/);
    expect(bad({ cursor: Buffer.from("2026-09-22 10:00:00+00|x' OR 1=1").toString('base64url') })).toMatch(/cursor/);
    expect(bad({ cursor: Buffer.from('2026-02-30 10:00:00+00|abc').toString('base64url') })).toMatch(/cursor/);
    expect(bad({ cursor: Buffer.from('2026-09-22 10:00:00+00|').toString('base64url') })).toMatch(/cursor/);
    expect(bad({ cursor: 'A'.repeat(400) })).toMatch(/cursor/);
  });
});

describe('statement cursor', () => {
  it('round-trips every Postgres timestamptz text shape', () => {
    for (const at of [
      '2026-09-22 10:00:00+00',
      '2026-09-22 10:00:00.1+00',
      '2026-09-22 10:00:00.123456+00',
      '2026-09-22 15:30:00.5+05:30',
      '2026-09-22 06:00:00-04',
    ]) {
      expect(decodeStatementCursor(encodeStatementCursor(at, 'tr_1'))).toEqual({ paidAtText: at, id: 'tr_1' });
    }
  });

  it('decode returns null for anything else', () => {
    expect(decodeStatementCursor('')).toBeNull();
    expect(decodeStatementCursor(Buffer.from('2026-09-22T10:00:00Z|a').toString('base64url'))).toBeNull();
    expect(decodeStatementCursor(Buffer.from('2026-09-22 10:00:00.1234567+00|a').toString('base64url'))).toBeNull();
    expect(decodeStatementCursor(Buffer.from('2026-09-22 10:00:00+00|a b').toString('base64url'))).toBeNull();
  });
});

function settled(over: Partial<SettledTransfer> = {}): SettledTransfer {
  return {
    id: 'tr_1',
    status: 'delivered',
    complianceStatus: 'cleared',
    refundStatus: 'none',
    amountSource: 200,
    sourceCurrency: 'USD',
    feeSource: 1.99,
    totalChargeSource: 201.99,
    fxRate: 85.2,
    amountInr: 17040,
    destinationCurrency: 'INR',
    destinationCountry: 'IN',
    payoutMethod: 'bank',
    paymentProviderRef: 'sim-tr_1',
    fundingRef: undefined,
    refundRef: undefined,
    createdAt: '2026-09-22T09:59:00.000Z',
    paidAt: '2026-09-22T10:00:00.123Z',
    deliveredAt: '2026-09-22T10:00:05.000Z',
    refundedAt: undefined,
    ...over,
  };
}

describe('statementRow', () => {
  it('projects exactly the documented fields', () => {
    const r = statementRow(settled());
    expect(Object.keys(r)).toEqual([...STATEMENT_COLUMNS]);
    expect(r).toEqual({
      reference: 'tr_1',
      status: 'delivered',
      compliance_status: 'cleared',
      refund_status: 'none',
      amount_source: 200,
      source_currency: 'USD',
      fee_source: 1.99,
      total_charge_source: 201.99,
      fx_rate: 85.2,
      amount_destination: 17040,
      destination_currency: 'INR',
      destination_country: 'IN',
      payout_rail: 'bank',
      provider_ref: 'sim-tr_1',
      funding_ref: null,
      refund_ref: null,
      created_at: '2026-09-22T09:59:00.000Z',
      paid_at: '2026-09-22T10:00:00.123Z',
      delivered_at: '2026-09-22T10:00:05.000Z',
      refunded_at: null,
    });
  });

  it('never carries the settlement partner, a payout destination or recipient identity', () => {
    // Even when the source object smuggles them in (a full Transfer passed by
    // mistake), the projection is an allow-list.
    const smuggled = {
      ...settled(),
      settlementPartnerId: 'globex',
      payoutDestination: '123456789012|HDFC0001234',
      recipientName: 'Anita',
      recipientPhone: '919876543210',
      phone: '15551230000',
    } as SettledTransfer;
    const r = statementRow(smuggled) as Record<string, unknown>;
    for (const k of Object.keys(r)) {
      expect(k).not.toMatch(/settlement|partner|recipient|phone/);
      if (k.includes('destination')) expect(['amount_destination', 'destination_currency', 'destination_country']).toContain(k);
    }
    expect(JSON.stringify(r)).not.toContain('globex');
    expect(JSON.stringify(r)).not.toContain('HDFC');
    expect(JSON.stringify(r)).not.toContain('Anita');
  });

  it('refund_status absent ⇒ none; destinationCurrency absent ⇒ INR', () => {
    const r = statementRow(settled({ refundStatus: undefined, destinationCurrency: undefined }));
    expect(r.refund_status).toBe('none');
    expect(r.destination_currency).toBe('INR');
  });
});

describe('statementTotals', () => {
  it('sums per currency in integer minor units (no float drift)', () => {
    const rows = [
      statementRow(settled({ amountSource: 0.1, amountInr: 8.52 })),
      statementRow(settled({ id: 'b', amountSource: 0.2, amountInr: 17.04 })),
      statementRow(settled({ id: 'c', amountSource: 50, sourceCurrency: 'GBP', amountInr: 5000, destinationCurrency: 'MXN', destinationCountry: 'MX' })),
    ];
    expect(statementTotals(rows)).toEqual({
      count: 3,
      amount_source_minor_by_currency: { USD: 30, GBP: 5000 },
      amount_destination_minor_by_currency: { INR: 2556, MXN: 500000 },
    });
  });

  it('an empty page totals to zero counts and empty maps', () => {
    expect(statementTotals([])).toEqual({
      count: 0,
      amount_source_minor_by_currency: {},
      amount_destination_minor_by_currency: {},
    });
  });
});

describe('toCsv', () => {
  it('writes a header, CRLF lines, quoted strings, bare numbers and empty nulls', () => {
    const csv = toCsv([statementRow(settled())]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(STATEMENT_COLUMNS.join(','));
    expect(lines[1]).toBe(
      '"tr_1","delivered","cleared","none",200,"USD",1.99,201.99,85.2,17040,"INR","IN","bank","sim-tr_1",,,' +
        '"2026-09-22T09:59:00.000Z","2026-09-22T10:00:00.123Z","2026-09-22T10:00:05.000Z",',
    );
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('an empty page is just the header', () => {
    expect(toCsv([])).toBe(`${STATEMENT_COLUMNS.join(',')}\r\n`);
  });

  it('doubles embedded quotes (RFC 4180) and keeps commas/newlines inside the quotes', () => {
    const csv = toCsv([statementRow(settled({ paymentProviderRef: 'a"b,c\nd' }))]);
    expect(csv).toContain('"a""b,c\nd"');
  });

  it("neutralises formula injection: a leading = + - @ TAB CR gets a bare ' inside the quotes", () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      const csv = toCsv([statementRow(settled({ paymentProviderRef: `${lead}HYPERLINK("x")` }))]);
      expect(csv).toContain(`"'${lead}HYPERLINK(""x"")"`);
    }
  });

  it('numbers are never prefixed — a negative number stays numeric', () => {
    const row = { ...statementRow(settled()), fx_rate: -1.5 };
    const csv = toCsv([row]);
    expect(csv).toContain(',-1.5,');
    expect(csv).not.toContain("'-1.5");
  });
});
