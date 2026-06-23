export const dynamic = 'force-dynamic';

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { requireScope } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { Sidebar } from '../../sidebar';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { PartnerApplicationDetails } from '@/lib/types';

// /admin-dashboard/partner-requests/[id] — the staff view of ONE submitted
// stage-2 partner application. Same PLATFORM-ONLY guard as the list: these are
// business-development records that cross no tenant boundary, so a partner-scoped
// staffer must never reach them (nav hides the parent; the requireScope bounce
// below closes the direct URL). This is partner business data, not customer PII,
// so values are shown verbatim (no masking/reveal flow).

/** Render bytes as a compact KB/MB string for the documents list. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A labeled value row — only rendered by the section helper when it has a value. */
function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-muted py-2.5 first:border-t-0 first:pt-0 sm:flex-row sm:gap-4">
      <div className="text-[11px] font-semibold tracking-[0.3px] text-muted-foreground uppercase sm:w-56 sm:shrink-0 sm:pt-0.5">
        {label}
      </div>
      <div className="break-words whitespace-pre-line text-foreground">{value}</div>
    </div>
  );
}

/**
 * A section card that renders only the fields with a (non-empty) value. If the
 * whole section is empty it renders nothing (returns null).
 */
function Section({
  title,
  description,
  fields,
}: {
  title: string;
  description?: string;
  fields: Array<[label: string, value: string | undefined]>;
}) {
  const present = fields.filter(
    (f): f is [string, string] => typeof f[1] === 'string' && f[1].trim() !== '',
  );
  if (present.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <div className="flex flex-col">
          {present.map(([label, value]) => (
            <FieldRow key={label} label={label} value={value} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default async function PartnerApplicationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { scope } = await requireScope();
  if (scope.kind !== 'platform') redirect('/admin-dashboard');

  const { id } = await params;
  const request = await getStore().getPartnerRequest(id);
  if (!request) notFound();

  const application = await getStore().getPartnerApplicationByRequestId(id);
  const d: PartnerApplicationDetails = application?.details ?? {};

  return (
    <>
      <Sidebar active="partner-requests" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">{request.companyName}</div>
            <div className="sh-page-sub">Partner application</div>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin-dashboard/partner-requests">← Back to requests</Link>
          </Button>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Lead summary</CardTitle>
              <CardDescription>The inbound &ldquo;Partner with us&rdquo; lead this application belongs to.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col">
                <FieldRow label="Company" value={request.companyName} />
                <FieldRow label="Email" value={request.email} />
                {request.phone && <FieldRow label="Phone" value={request.phone} />}
                {request.corridors.length > 0 && (
                  <div className="flex flex-col gap-0.5 border-t border-muted py-2.5 sm:flex-row sm:gap-4">
                    <div className="text-[11px] font-semibold tracking-[0.3px] text-muted-foreground uppercase sm:w-56 sm:shrink-0 sm:pt-1">
                      Corridors
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {request.corridors.map((c) => (
                        <Badge key={c} variant="outline">{c}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {application && (
                  <FieldRow label="Submitted" value={new Date(application.submittedAt).toLocaleString()} />
                )}
              </div>
            </CardContent>
          </Card>

          {!application ? (
            <Card>
              <CardContent className="px-6 py-10 text-center text-[13px] text-muted-foreground">
                No application submitted yet (status: {request.applicationStatus ?? 'invited'}).
              </CardContent>
            </Card>
          ) : (
            <>
              <Section
                title="§1 Company & legal entity"
                fields={[
                  ['Legal name', d.legalName],
                  ['Trading name', d.tradingName],
                  ['Registration number', d.registrationNumber],
                  ['Country of incorporation', d.countryOfIncorporation],
                  ['Registered address', d.registeredAddress],
                  ['Website', d.website],
                  ['Year established', d.yearEstablished],
                  ['Ownership', d.ownership],
                ]}
              />
              <Section
                title="§2 Licensing, regulation & compliance"
                fields={[
                  ['Licensed', d.isLicensed],
                  ['License types', d.licenseTypes],
                  ['Primary regulator', d.primaryRegulator],
                  ['Other jurisdictions', d.otherJurisdictions],
                  ['AML program', d.amlProgram],
                  ['Compliance officer', d.complianceOfficerName],
                  ['Compliance officer email', d.complianceOfficerEmail],
                  ['Sanctions approach', d.sanctionsApproach],
                  ['Last audit date', d.lastAuditDate],
                ]}
              />
              <Section
                title="§3 Operations & settlement"
                fields={[
                  ['Corridors', d.corridors],
                  ['Expected monthly volume (USD)', d.expectedMonthlyVolumeUsd],
                  ['Average transfer size', d.avgTransferSize],
                  ['Current monthly volume', d.currentMonthlyVolume],
                  ['Settlement bank', d.settlementBank],
                  ['Settlement country', d.settlementCountry],
                  ['Settlement currencies', d.settlementCurrencies],
                  ['Payout methods', d.payoutMethods],
                ]}
              />
              <Section
                title="§4 Technical & contacts"
                fields={[
                  ['Integration preference', d.integrationPreference],
                  ['WhatsApp number', d.whatsappNumber],
                  ['Brand name', d.brandName],
                  ['Primary contact', d.primaryContact],
                  ['Compliance contact', d.complianceContact],
                  ['Technical contact', d.technicalContact],
                  ['Notes', d.notes],
                ]}
              />

              <Card>
                <CardHeader>
                  <CardTitle>Documents</CardTitle>
                  <CardDescription>
                    {application.documents.length} file{application.documents.length === 1 ? '' : 's'} uploaded with this application.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {application.documents.length === 0 ? (
                    <div className="text-[13px] text-muted-foreground">No documents uploaded.</div>
                  ) : (
                    <div className="flex flex-col">
                      {application.documents.map((doc, i) => (
                        <div
                          key={`${doc.url}-${i}`}
                          className="flex flex-wrap items-center justify-between gap-2 border-t border-muted py-2.5 first:border-t-0 first:pt-0"
                        >
                          <a
                            href={doc.url}
                            target="_blank"
                            rel="noopener"
                            className="font-medium text-primary hover:underline"
                          >
                            {doc.label}
                          </a>
                          <span className="text-xs text-muted-foreground">
                            {[doc.contentType, formatBytes(doc.size)].filter(Boolean).join(' · ')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </main>
    </>
  );
}
