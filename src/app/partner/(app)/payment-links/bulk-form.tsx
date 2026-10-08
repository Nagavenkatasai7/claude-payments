'use client';

import { useState } from 'react';
import { t } from '@/lib/i18n';
import { CSV_MAX_BYTES, toCsv } from '@/lib/csv-parse';
import { Badge, Button, Field, Select } from '@/components/ds';
import { checkBulkAction, createBulkAction, type BulkCheckState, type BulkCreateState } from './actions';
import type { PayeeOption } from './create-form';

// Batch B2: CSV upload. Step 1 reads the file in the browser and sends its TEXT to the check
// action, which reports every row and saves nothing. Step 2 (after the partner reads the report)
// sends the same text again with the chosen company; the server re-runs the same check and makes
// the ready rows only. The made links can be downloaded as CSV here; SmartRemit sends nothing.

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BulkUploadForm({ payees, templateCsv }: { payees: PayeeOption[]; templateCsv: string }) {
  const [text, setText] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [report, setReport] = useState<BulkCheckState | null>(null);
  const [made, setMade] = useState<BulkCreateState | null>(null);
  const [payeeId, setPayeeId] = useState(payees[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  async function onFile(file: File | undefined) {
    setReport(null);
    setMade(null);
    setFileError(null);
    setText(null);
    if (!file) return;
    if (file.size > CSV_MAX_BYTES) {
      setFileError(t('partner.paymentLinks.bulk.tooBig'));
      return;
    }
    setText(await file.text());
  }

  async function check() {
    if (text === null) return;
    setBusy(true);
    setMade(null);
    try {
      const fd = new FormData();
      fd.set('csv', text);
      setReport(await checkBulkAction(fd));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (text === null) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('csv', text);
      fd.set('payeeId', payeeId);
      setMade(await createBulkAction(fd));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="partner-paylink-bulk">
      <div>
        <Button type="button" size="sm" variant="link" onClick={() => download('payment-links-template.csv', templateCsv)}>
          {t('partner.paymentLinks.bulk.template')}
        </Button>
      </div>
      <Field name="csv" label={t('partner.paymentLinks.bulk.file')} error={fileError ?? undefined}>
        {(ids) => (
          <input
            id={ids.id}
            type="file"
            accept=".csv,text/csv"
            aria-describedby={ids.describedBy}
            className="text-[14px] text-ds-ink"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        )}
      </Field>
      <div>
        <Button type="button" size="md" variant="ghost" disabled={text === null || busy} onClick={() => void check()}>
          {t('partner.paymentLinks.bulk.check')}
        </Button>
      </div>

      <div aria-live="polite">
        {report && !report.ok ? (
          <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
            {report.error}
          </p>
        ) : null}
      </div>

      {report && report.ok ? (
        <div className="flex flex-col gap-3">
          <p className="text-[14px] font-semibold text-ds-ink">
            {t('partner.paymentLinks.bulk.summary', { valid: report.valid, invalid: report.invalid, warned: report.warned })}
          </p>
          <div className="max-h-[420px] overflow-auto rounded-ds-inner border border-ds-border">
            <table className="w-full border-collapse text-left text-[13px] text-ds-ink">
              <thead className="sticky top-0 bg-ds-ground text-[12px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">{t('partner.paymentLinks.bulk.line')}</th>
                  <th scope="col" className="px-3 py-2">{t('partner.paymentLinks.col.reference')}</th>
                  <th scope="col" className="px-3 py-2">{t('partner.paymentLinks.col.customer')}</th>
                  <th scope="col" className="px-3 py-2">{t('partner.paymentLinks.col.amount')}</th>
                  <th scope="col" className="px-3 py-2">{t('partner.paymentLinks.bulk.result')}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.line} className="border-t border-ds-border align-top">
                    <td className="px-3 py-2 tabular-nums">{r.line}</td>
                    <td className="max-w-[160px] break-words px-3 py-2">{r.cells.reference}</td>
                    <td className="max-w-[160px] break-words px-3 py-2">{r.cells.name}</td>
                    <td className="px-3 py-2 tabular-nums">{r.cells.amount}</td>
                    <td className="px-3 py-2">
                      {r.ok ? <Badge tone="success">{t('partner.paymentLinks.bulk.ready')}</Badge> : null}
                      {r.errors.map((e) => (
                        <p key={e} className="text-ds-danger-ink">
                          {e}
                        </p>
                      ))}
                      {r.warnings.map((w) => (
                        <p key={w} className="text-ds-warning-ink">
                          {w}
                        </p>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.valid > 0 && !(made && made.ok) ? (
            <div className="flex flex-col gap-3">
              <Field name="bulkPayee" label={t('partner.paymentLinks.create.payee')} required>
                {(ids) => (
                  <Select id={ids.id} value={payeeId} onChange={(e) => setPayeeId(e.target.value)} aria-describedby={ids.describedBy}>
                    {payees.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.legalName}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {report.invalid > 0 ? <p className="text-[13px] text-ds-ink-muted">{t('partner.paymentLinks.bulk.skipNote')}</p> : null}
              <div>
                <Button type="button" size="md" disabled={busy || payeeId === ''} onClick={() => void create()}>
                  {t('partner.paymentLinks.bulk.confirm', { count: report.valid })}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div aria-live="polite">
        {made && !made.ok ? (
          <p role="alert" className="text-[14px] font-semibold text-ds-danger-ink">
            {made.error}
          </p>
        ) : null}
        {made && made.ok ? (
          <div role="status" className="flex flex-col gap-2 rounded-ds-inner border border-ds-success-border bg-ds-success-bg p-4">
            <p className="text-[14px] font-semibold text-ds-success-ink">{t('partner.paymentLinks.bulk.done', { count: made.links.length })}</p>
            <div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => download('payment-links.csv', toCsv([['reference', 'link'], ...made.links.map((l) => [l.reference, l.url])]))}
              >
                {t('partner.paymentLinks.bulk.download')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
