import { t, type MessageKey } from '@/lib/i18n';
import { amlEvidenceDetailRows, type AmlEvidenceView, type ScreeningView } from '@/lib/partner-screening-view';

// Fix pack 7 T12 (P8, P15): the read-only hold evidence on /partner/transfers/[id], rendered ONLY
// for a qualified compliance user of a certified owner and only after the render's
// `transfer.screening.view` audit row was written (the page decides both). Server component.
// It shows the fields of the masked view and nothing else: list source, version, screened time,
// result, and per party the role, matched, score and matched list entry id. Never a hash, a name,
// a phone or an amount (ScreeningView carries none). The AML part shows closed labels only: the
// rule labels, the closed scam-pattern label (P8 overrides PR6 P21 for this one surface; never
// the customer's text) and the warning-signal labels; with no record, the generic AML label.

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const when = (iso: string) => (Number.isFinite(Date.parse(iso)) ? `${WHEN.format(new Date(iso))} UTC` : '—');

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 py-1.5 text-[14px]">
      <dt className="text-ds-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right text-ds-ink">{children}</dd>
    </div>
  );
}

export function HoldEvidencePanel({ screening, aml }: { screening: ScreeningView | null; aml: AmlEvidenceView | null }) {
  const detail = aml ? amlEvidenceDetailRows(aml) : [];
  return (
    <section className="rounded-ds-inner border border-ds-border p-4" data-testid="partner-hold-evidence">
      <h3 className="text-[15px] font-semibold text-ds-ink">{t('partner.evidence.title')}</h3>
      {screening ? (
        <>
          <dl className="mt-2 divide-y divide-ds-border">
            <Item label={t('partner.evidence.list')}>
              <span className="font-mono text-[13px]">{screening.listSource}</span>
            </Item>
            <Item label={t('partner.evidence.version')}>
              <span className="font-mono text-[13px]">{screening.listVersion}</span>
            </Item>
            <Item label={t('partner.evidence.screenedAt')}>
              <time dateTime={screening.screenedAt}>{when(screening.screenedAt)}</time>
            </Item>
            <Item label={t('partner.evidence.decision')}>
              <span className="font-mono text-[13px]">{screening.decision}</span>
            </Item>
          </dl>
          <ul className="mt-3 flex flex-col gap-2">
            {screening.parties.map((p, i) => (
              <li key={i} className="rounded-ds-inner border border-ds-border px-3 py-2 text-[13.5px]">
                <span className="font-semibold text-ds-ink">
                  {t('partner.evidence.party')}: {t(`partner.evidence.role.${p.role}` as MessageKey)}
                </span>
                {p.screened ? (
                  <span className="mt-1 flex flex-wrap gap-x-4 text-ds-ink-muted">
                    <span>
                      {t('partner.evidence.matched')}: {t(p.matched ? 'partner.evidence.matchedYes' : 'partner.evidence.matchedNo')}
                    </span>
                    {p.score !== null ? (
                      <span>
                        {t('partner.evidence.score')}: <span className="tabular-nums">{p.score}</span>
                      </span>
                    ) : null}
                    {p.matchedEntryId ? (
                      <span>
                        {t('partner.evidence.entry')}: <span className="font-mono">{p.matchedEntryId}</span>
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="mt-1 block text-ds-ink-muted">{t('partner.evidence.notScreened')}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-2 text-[13.5px] text-ds-ink-muted">{t('partner.evidence.notScreened')}</p>
      )}
      {aml ? (
        <div className="mt-3 text-[13.5px]">
          {aml.kinds.length === 0 ? (
            <p className="text-ds-ink">{t('partner.transfers.reason.additional')}</p>
          ) : (
            <ul className="list-disc pl-5 text-ds-ink">
              {aml.kinds.map((k) => (
                <li key={k}>
                  {t(`partner.evidence.aml.${k}` as MessageKey)}
                  {k === 'aml_rule' && aml.rules.length > 0
                    ? `: ${aml.rules.map((r) => t(`partner.reviews.aml.rule.${r}` as MessageKey)).join(', ')}`
                    : null}
                </li>
              ))}
            </ul>
          )}
          {detail.length > 0 ? (
            <dl className="mt-2 divide-y divide-ds-border">
              {detail.map((r) => (
                <Item key={r.label} label={r.label}>
                  {r.value}
                </Item>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
