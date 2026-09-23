import type { ReactNode } from 'react';
import Link from 'next/link';
import type { ReceiptDisclosure } from '@/lib/remittance-disclosure';
import {
  DISCLOSURE_DRAFT_BADGE,
  DISCLOSURE_LABELS as L,
  cancelWindowLine,
} from '@/lib/legal/disclosure-drafts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

// Program-Fix 15 PR B — the Reg E receipt disclosure (12 CFR 1005.31(b)(2)):
// date available, the provider of record (the licensed partner, from its own
// config — the demo tenant shows the demo note instead), its regulator, the
// CFPB contact and the rights summary. Pure render of buildReceiptDisclosure();
// every string is a DRAFT for counsel. Rows wrap instead of overflowing (390px).

const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });

function Line({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-words text-right ${strong ? 'font-semibold text-foreground' : 'text-foreground'}`}>
        {value}
      </dd>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a className="break-all text-primary underline underline-offset-2" href={href} target="_blank" rel="noopener noreferrer">
      {children ?? href.replace(/^https:\/\//, '')}
    </a>
  );
}

export function ReceiptDisclosureCard({ disclosure }: { disclosure: ReceiptDisclosure }) {
  const p = disclosure.provider;
  // The receipt's Amount card already shows the amount, fee, total, rate and
  // total to recipient; this card adds only the date available from the lines.
  const dateAvailable = disclosure.lines.find((l) => l.label === L.dateAvailable);
  return (
    <Card className="sm:col-span-2" data-disclosure-version={disclosure.version}>
      <CardHeader>
        <CardTitle>{L.receiptHeading}</CardTitle>
        <CardDescription>{DISCLOSURE_DRAFT_BADGE}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl>
          {dateAvailable && <Line label={dateAvailable.label} value={dateAvailable.value} strong />}
          <Separator className="my-1" />
          {p.name && <Line label={L.provider} value={<span className="font-medium">{p.name}</span>} />}
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
                <ExternalLink href={disclosure.cfpb.website}>{disclosure.cfpb.websiteLabel}</ExternalLink>
                {' · '}
                <span className="whitespace-nowrap">{disclosure.cfpb.phone}</span>
              </>
            }
          />
        </dl>
        {p.note && <p className="mt-2 text-sm text-muted-foreground">{p.note}</p>}
        <p className="mt-3 max-w-prose text-sm text-muted-foreground">{disclosure.rightsSummary}</p>
        {disclosure.cancelDeadline && (
          <p className="mt-2 text-sm font-medium text-foreground">
            {cancelWindowLine(TIME_FMT.format(new Date(disclosure.cancelDeadline)))}
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">{disclosure.thirdPartyFeeNote}</p>
        <nav aria-label="Legal" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {disclosure.links.map((l) => (
            <Link key={l.href} href={l.href} className="text-primary underline underline-offset-2">
              {l.label}
            </Link>
          ))}
        </nav>
      </CardContent>
    </Card>
  );
}
