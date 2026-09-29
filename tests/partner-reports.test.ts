import { describe, it, expect } from 'vitest';
import {
  FEES_COLUMNS,
  MAX_REPORT_ROWS,
  REPORT_KINDS,
  TRANSFER_EXPORT_COLUMNS,
  feesMonthlyRows,
  parseReportRequest,
  reportFilename,
  reportPolicy,
  rowsToCsv,
  transferExportRow,
} from '@/lib/partner-reports';
import { csvCell } from '@/lib/settlement-statement';
import { PARTNER_MONEY_READ, PARTNER_REPORTS } from '@/lib/partner-access';
import type { Transfer } from '@/lib/types';

// UI redesign M3-16, Task 16.1: the pure half of partner Reports.

const NOW = new Date(Date.UTC(2026, 8, 29, 15, 0, 0)); // 2026-09-29T15:00Z

function fd(v: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
}

const FULL: Transfer = {
  id: 'tx_abc123',
  partnerId: 'pa',
  phone: '14155551234',
  amountUsd: 100,
  feeUsd: 2,
  totalChargeUsd: 102,
  fxRate: 85,
  amountInr: 8500,
  recipientName: 'Testname Samplesurname',
  recipientLegalName: 'Testname Middle Samplesurname',
  recipientPhone: '919876543210',
  payoutMethod: 'bank',
  payoutDestination: '000011112222|HDFC0001111',
  fundingMethod: 'bank_transfer',
  complianceStatus: 'cleared',
  complianceReasons: ['edd_required'],
  status: 'paid',
  createdAt: '2026-09-20T10:00:00.000Z',
  paidAt: '2026-09-20T10:05:00.000Z',
  sourceCountry: 'US',
  sourceCurrency: 'USD',
  destinationCountry: 'IN',
  destinationCurrency: 'INR',
  amountSource: 100,
  feeSource: 2,
  totalChargeSource: 102,
} as Transfer;

describe('transferExportRow (allow-list projection)', () => {
  it('has exactly the TRANSFER_EXPORT_COLUMNS keys, even given a full decrypted Transfer', () => {
    const row = transferExportRow(FULL);
    expect(Object.keys(row).sort()).toEqual([...TRANSFER_EXPORT_COLUMNS].sort());
  });

  it('masks the sender phone to ****<last4>', () => {
    expect(transferExportRow(FULL).sender_phone).toBe('****1234');
  });

  it('masks the recipient name and never carries the legal name, phones or the full destination', () => {
    const row = transferExportRow(FULL);
    expect(row.recipient).toBe('Testname S.');
    const s = JSON.stringify(row);
    expect(s).not.toContain('Samplesurname');
    expect(s).not.toContain('Middle');
    expect(s).not.toContain('14155551234');
    expect(s).not.toContain('919876543210');
    expect(s).not.toContain('000011112222');
    expect(s).not.toContain('HDFC');
    expect(s).not.toContain('edd_required');
  });

  it('keeps a masked-read destination (****last4) and collapses anything else to ****', () => {
    expect(transferExportRow({ ...FULL, payoutDestination: '****2222' }).payout_destination).toBe('****2222');
    expect(transferExportRow(FULL).payout_destination).toBe('****');
    expect(transferExportRow({ ...FULL, payoutDestination: '' }).payout_destination).toBe(null);
  });
});

describe('csvCell (formula-injection guard, exported)', () => {
  it('prefixes a formula lead with a quote inside the cell', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    for (const lead of ['+', '-', '@', '\t', '\r']) expect(csvCell(`${lead}1`)).toBe(`"'${lead}1"`);
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell(-5)).toBe('-5');
  });

  it('rowsToCsv guards every string cell', () => {
    const csv = rowsToCsv(['a', 'b'] as const, [{ a: '=1+1', b: 2 }]);
    expect(csv).toBe(`a,b\r\n"'=1+1",2\r\n`);
  });
});

describe('parseReportRequest', () => {
  it('accepts a settlements window up to 31 days (inclusive dates → half-open)', () => {
    const r = parseReportRequest(fd({ kind: 'settlements', from: '2026-08-01', to: '2026-08-31' }), NOW);
    expect(r).toEqual({ ok: true, kind: 'settlements', params: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' } });
  });

  it('refuses a 32-day window', () => {
    const r = parseReportRequest(fd({ kind: 'settlements', from: '2026-08-01', to: '2026-09-01' }), NOW);
    expect(r).toEqual({ ok: false, error: 'window' });
  });

  it('refuses a reversed window, a malformed date and a future end', () => {
    expect(parseReportRequest(fd({ kind: 'settlements', from: '2026-08-10', to: '2026-08-01' }), NOW)).toEqual({ ok: false, error: 'window' });
    expect(parseReportRequest(fd({ kind: 'settlements', from: '2026-02-30', to: '2026-03-01' }), NOW)).toEqual({ ok: false, error: 'date' });
    expect(parseReportRequest(fd({ kind: 'settlements', from: '2026-09-29', to: '2026-09-30' }), NOW)).toEqual({ ok: false, error: 'future' });
  });

  it('defaults transfers to the last 31 days and keeps only closed-set filters', () => {
    const r = parseReportRequest(fd({ kind: 'transfers', status: 'paid', environment: 'test', partnerId: 'pb', q: '14155551234' }), NOW);
    expect(r).toEqual({
      ok: true,
      kind: 'transfers',
      params: { from: '2026-08-30T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z', status: 'paid', environment: 'test' },
    });
    const bad = parseReportRequest(fd({ kind: 'transfers', status: 'nope', environment: 'x' }), NOW);
    expect(bad).toEqual({ ok: true, kind: 'transfers', params: { from: '2026-08-30T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z', environment: 'live' } });
  });

  it('fees_monthly takes YYYY-MM, not in the future', () => {
    expect(parseReportRequest(fd({ kind: 'fees_monthly', month: '2026-09' }), NOW)).toEqual({ ok: true, kind: 'fees_monthly', params: { month: '2026-09' } });
    expect(parseReportRequest(fd({ kind: 'fees_monthly', month: '2026-10' }), NOW)).toEqual({ ok: false, error: 'future' });
    expect(parseReportRequest(fd({ kind: 'fees_monthly', month: '2026-13' }), NOW)).toEqual({ ok: false, error: 'date' });
    expect(parseReportRequest(fd({ kind: 'fees_monthly', month: '26-09' }), NOW)).toEqual({ ok: false, error: 'date' });
  });

  it('refuses an unknown kind', () => {
    expect(parseReportRequest(fd({ kind: 'customers' }), NOW)).toEqual({ ok: false, error: 'kind' });
    expect(parseReportRequest(fd({}), NOW)).toEqual({ ok: false, error: 'kind' });
  });
});

describe('reportPolicy', () => {
  it('transfers → money-read (admin, agent, finance); settlements and fees → reports (admin, finance)', () => {
    expect(reportPolicy('transfers')).toBe(PARTNER_MONEY_READ);
    expect(reportPolicy('settlements')).toBe(PARTNER_REPORTS);
    expect(reportPolicy('fees_monthly')).toBe(PARTNER_REPORTS);
    expect(REPORT_KINDS).toEqual(['settlements', 'transfers', 'fees_monthly']);
  });
});

describe('feesMonthlyRows', () => {
  it('projects the day aggregates onto FEES_COLUMNS', () => {
    const rows = feesMonthlyRows([{ day: '2026-09-01', currency: 'USD', transfers: 3, amountSource: 300.5, feeSource: 6, feeUsd: 6 }]);
    expect(rows).toEqual([{ day: '2026-09-01', source_currency: 'USD', transfers: 3, amount_source: 300.5, fee_source: 6, fee_usd: 6 }]);
    expect(Object.keys(rows[0])).toEqual([...FEES_COLUMNS]);
  });
});

describe('limits and names', () => {
  it('starts the row cap at 10k and names files without tenant data', () => {
    expect(MAX_REPORT_ROWS).toBe(10_000);
    expect(reportFilename('settlements', new Date('2026-09-29T12:00:00Z'))).toBe('smartremit-settlements-2026-09-29.csv');
  });
});
