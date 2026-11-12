import type { ReactNode } from 'react';
import type { ReceiptDisclosure } from '@/lib/remittance-disclosure';
import { DISCLOSURE_LABELS as L, cancelWindowLine } from '@/lib/legal/disclosure-drafts';

// Fix pack 6 (P11, R46): the printable Reg E receipt (12 CFR 1005.31(b)(2)) on the paid pay
// page. A server component (no script: the CSP is enforced, the browser's Print command prints
// it). Dark theme of remittance-disclosure.tsx with `print:` overrides (white sheet, dark
// text). Pure render of buildReceiptDisclosure / receiptFromSnapshot. It renders NO provider
// line: the page heading's data-testid="provider-line" stays the only one. The draft wording is
// pinned by data-disclosure-version (its version says draft); the "for counsel review" badge
// is left out because a held page must never say "review" (P11, no tipping off).

const lineClasses = 'flex flex-wrap items-baseline justify-between gap-x-3 py-1 text-[13px] leading-normal';
const labelClasses = 'text-[#8696a0] print:text-neutral-700';
const valueClasses = 'min-w-0 break-words text-right';
const mutedClasses = 'text-xs leading-normal text-[#8696a0] print:text-neutral-700';
const linkClasses = 'text-[#53bdeb] underline underline-offset-2 print:text-black';

const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });

function Line({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className={lineClasses} style={strong ? { fontWeight: 700 } : undefined}>
      <span className={labelClasses}>{label}</span>
      <span className={valueClasses}>{value}</span>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a className={`${linkClasses} break-all`} href={href} target="_blank" rel="noopener noreferrer">
      {children ?? href.replace(/^https:\/\//, '')}
    </a>
  );
}

export function PayReceipt({ receipt, transferId }: { receipt: ReceiptDisclosure; transferId: string }) {
  const p = receipt.provider;
  return (
    <section
      data-testid="pay-receipt"
      data-disclosure-version={receipt.version}
      aria-labelledby="pay-receipt-heading"
      className="mt-5 rounded-xl border border-[#2a3942] bg-[#111b21] p-3.5 print:border-0 print:bg-white print:p-0 print:text-black"
    >
      <h2 id="pay-receipt-heading" className="mb-1 text-sm leading-normal font-semibold">
        {L.receiptHeading}
      </h2>
      <Line label="Transfer ID" value={<span className="font-mono">{transferId}</span>} />
      {receipt.lines.map((line) => (
        <Line key={line.label} label={line.label} value={line.value} strong={line.strong} />
      ))}
      <p className={`mt-1.5 ${mutedClasses}`}>{receipt.thirdPartyFeeNote}</p>

      <div className="mt-3 border-t border-[#2a3942] pt-2 print:border-neutral-300">
        {p.name && <Line label={L.provider} value={p.name} />}
        {p.note && <p className={`py-1 ${mutedClasses}`}>{p.note}</p>}
        {p.licenseIds.length > 0 && <Line label={L.licences} value={p.licenseIds.join(', ')} />}
        {p.phone && <Line label={L.providerPhone} value={<span className="whitespace-nowrap">{p.phone}</span>} />}
        {p.website && <Line label={L.providerWebsite} value={<ExternalLink href={p.website} />} />}
        {p.stateRegulator && (
          <Line
            label={L.stateRegulator}
            value={
              <>
                {p.stateRegulator.name}
                {p.stateRegulator.phone && <> · <span className="whitespace-nowrap">{p.stateRegulator.phone}</span></>}
                {p.stateRegulator.website && (
                  <>
                    {' · '}
                    <ExternalLink href={p.stateRegulator.website} />
                  </>
                )}
              </>
            }
          />
        )}
        <Line
          label={L.cfpb}
          value={
            <>
              <ExternalLink href={receipt.cfpb.website}>{receipt.cfpb.websiteLabel}</ExternalLink>
              {' · '}
              <span className="whitespace-nowrap">{receipt.cfpb.phone}</span>
            </>
          }
        />
      </div>

      <p className={`mt-2 ${mutedClasses}`}>{receipt.rightsSummary}</p>
      {receipt.cancelDeadline && (
        <p className="mt-2 text-xs leading-normal font-semibold">
          {cancelWindowLine(TIME_FMT.format(new Date(receipt.cancelDeadline)))}
        </p>
      )}
      <nav aria-label="Legal" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-normal">
        {receipt.links.map((l) => (
          <a key={l.href} className={linkClasses} href={l.href} target="_blank" rel="noopener noreferrer">
            {l.label}
          </a>
        ))}
      </nav>
    </section>
  );
}
