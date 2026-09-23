import type { PrepaymentDisclosure } from '@/lib/remittance-disclosure';
import { DISCLOSURE_DRAFT_BADGE, DISCLOSURE_LABELS as L } from '@/lib/legal/disclosure-drafts';

// Program-Fix 15 PR B — the Reg E pre-payment disclosure card (12 CFR
// 1005.31(b)(1)) on the hosted pay page, in the page's WhatsApp-dark theme.
// Pure render of buildPrepaymentDisclosure(); every string is a DRAFT for
// counsel (src/lib/legal/disclosure-drafts.ts). Rows WRAP (label over value)
// instead of overflowing, so a long entity name, licence id or URL never
// scrolls the page sideways at 390px.

const lineClasses = 'flex flex-wrap items-baseline justify-between gap-x-3 py-1 text-[13px] leading-normal';
const labelClasses = 'text-[#8696a0]';
const valueClasses = 'min-w-0 break-words text-right';
const linkClasses = 'text-[#53bdeb] underline underline-offset-2';

function Line({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={lineClasses} style={strong ? { fontWeight: 700 } : undefined}>
      <span className={labelClasses}>{label}</span>
      <span className={valueClasses}>{value}</span>
    </div>
  );
}

function ExternalLink({ href }: { href: string }) {
  return (
    <a className={`${linkClasses} break-all`} href={href} target="_blank" rel="noopener noreferrer">
      {href.replace(/^https:\/\//, '')}
    </a>
  );
}

export function RemittanceDisclosure({ disclosure }: { disclosure: PrepaymentDisclosure }) {
  const p = disclosure.provider;
  return (
    <section
      aria-labelledby="reg-e-disclosure-heading"
      className="mb-5 rounded-xl border border-[#2a3942] bg-[#111b21] p-3.5"
      data-disclosure-version={disclosure.version}
    >
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="reg-e-disclosure-heading" className="text-sm leading-normal font-semibold">
          {L.heading}
        </h2>
        <span className="text-[11px] leading-normal text-[#8696a0]">{DISCLOSURE_DRAFT_BADGE}</span>
      </div>
      {disclosure.lines.map((line) => (
        <Line key={line.label} label={line.label} value={line.value} strong={line.strong} />
      ))}
      <p className="mt-1.5 text-xs leading-normal text-[#8696a0]">{disclosure.thirdPartyFeeNote}</p>

      <div className="mt-3 border-t border-[#2a3942] pt-2">
        {p.name && <Line label={L.provider} value={p.name} />}
        {p.note && <p className="py-1 text-xs leading-normal text-[#8696a0]">{p.note}</p>}
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
      </div>

      <p className="mt-2 text-xs leading-normal text-[#8696a0]">{disclosure.rightsSummary}</p>
      <nav aria-label="Legal" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-normal">
        {disclosure.links.map((l) => (
          <a key={l.href} className={linkClasses} href={l.href} target="_blank" rel="noopener">
            {l.label}
          </a>
        ))}
      </nav>
    </section>
  );
}
