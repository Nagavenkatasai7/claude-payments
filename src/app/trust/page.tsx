import type { ReactNode } from 'react';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ds';
import { COMPLIANCE_AS_OF, COMPLIANCE_STATUS } from '@/content/trust/compliance-status';
import { DISCLOSURE_CONTACT, DISCLOSURE_POLICY, DISCLOSURE_SUBJECT, SECURITY_MD_URL } from '@/content/trust/disclosure';
import { SECURITY_POINTS } from '@/content/trust/security-overview';
import { NO_PERSONAL_DATA_SOURCES, SUBPROCESSORS } from '@/content/trust/subprocessors';

// The /trust page: a static server component rendered from the trust content modules
// (src/content/trust/**). No data reads, no client JS; prerendered at build.

const H2 = 'text-[22px] font-bold tracking-[-0.015em] text-ds-ink';
const LEAD = 'mt-2 max-w-[72ch] text-[15px] leading-relaxed text-ds-ink-muted';
const TH = 'whitespace-nowrap border-b border-ds-border bg-ds-ground px-4 py-2.5 text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ds-ink-muted';
const TD = 'border-b border-ds-border px-4 py-3 align-top';
const LINK = 'font-semibold text-ds-primary hover:underline';

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="mt-12 scroll-mt-24">
      <h2 id={`${id}-title`} className={H2}>
        {title}
      </h2>
      {lead ? <p className={LEAD}>{lead}</p> : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** A static table: it scrolls sideways inside its own wrapper, never the page. */
function StaticTable({ caption, headers, children }: { caption: string; headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-ds-card border border-ds-border bg-ds-surface">
      <table className="w-full border-collapse text-left text-[14px] text-ds-ink">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col" className={TH}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function List({ items }: { items: readonly string[] }) {
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5 text-[15px] leading-relaxed text-ds-ink-muted">
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}

export default function TrustPage() {
  const mailto = `mailto:${DISCLOSURE_CONTACT}?subject=${encodeURIComponent(DISCLOSURE_SUBJECT)}`;
  return (
    <article className="break-words">
      <PageHeader
        title="Trust & security"
        sub={
          <>
            How SmartRemit protects your data, where we stand on compliance, who processes data for us, and how to report a
            security issue. As of {COMPLIANCE_AS_OF}.
          </>
        }
      />

      <Section id="security" title="Security overview">
        {SECURITY_POINTS.length === 0 ? (
          <EmptyState title="Nothing listed yet" body="Our security overview is being written." />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {SECURITY_POINTS.map((p) => (
              <li key={p.title} className="min-w-0">
                <Card className="h-full p-5 sm:p-6">
                  <h3 className="text-[17px] font-semibold text-ds-ink">{p.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-ds-ink-muted">{p.body}</p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="compliance"
        title="Compliance status"
        lead="Where we stand today. We will update this page when an examination or certification is complete."
      >
        {COMPLIANCE_STATUS.length === 0 ? (
          <EmptyState title="Nothing listed yet" body="Our compliance status is being written." />
        ) : (
          <StaticTable caption="Compliance status by framework" headers={['Framework', 'Status']}>
            {COMPLIANCE_STATUS.map((r) => (
              <tr key={r.framework} data-framework={r.framework}>
                <th scope="row" className={`${TD} whitespace-nowrap font-semibold text-ds-ink`}>
                  {r.framework}
                </th>
                <td className={`${TD} min-w-[18rem] text-ds-ink-muted`}>{r.status}</td>
              </tr>
            ))}
          </StaticTable>
        )}
      </Section>

      <Section
        id="subprocessors"
        title="Sub-processors"
        lead="The third parties that process data to run the service. Where a region has not been verified yet, we say so."
      >
        {SUBPROCESSORS.length === 0 ? (
          <EmptyState title="Nothing listed yet" body="Our sub-processor list is being prepared." />
        ) : (
          <StaticTable caption="Sub-processors" headers={['Provider', 'Purpose', 'Data', 'Region']}>
            {SUBPROCESSORS.map((s) => (
              <tr key={s.name} data-subprocessor={s.name}>
                <th scope="row" className={`${TD} min-w-[9rem] font-semibold text-ds-ink`}>
                  {s.name}
                </th>
                <td className={`${TD} min-w-[14rem] text-ds-ink-muted`}>{s.purpose}</td>
                <td className={`${TD} min-w-[14rem] text-ds-ink-muted`}>{s.data}</td>
                <td className={`${TD} min-w-[10rem]`}>
                  {s.regionStatus === 'confirmed' ? (
                    <span className="text-ds-ink">{s.region}</span>
                  ) : (
                    <Badge tone="warning">{s.region}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </StaticTable>
        )}
        {NO_PERSONAL_DATA_SOURCES.length > 0 ? (
          <div className="mt-6">
            <h3 className="text-[15px] font-semibold text-ds-ink">Services we call that receive no personal data</h3>
            <List items={NO_PERSONAL_DATA_SOURCES} />
          </div>
        ) : null}
      </Section>

      <Section id="disclosure" title="Responsible disclosure" lead="Found a security issue? We want to hear about it.">
        <Card className="p-5 sm:p-6">
          <p className="text-[15px] leading-relaxed text-ds-ink">
            Email{' '}
            <a className={LINK} href={mailto}>
              {DISCLOSURE_CONTACT}
            </a>{' '}
            with the subject “{DISCLOSURE_SUBJECT}”. Please do not report security issues in public.
          </p>
          <div className="mt-5 grid gap-5 md:grid-cols-3">
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold text-ds-ink">In scope</h3>
              <List items={DISCLOSURE_POLICY.scope} />
            </div>
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold text-ds-ink">Please</h3>
              <List items={DISCLOSURE_POLICY.please} />
            </div>
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold text-ds-ink">Please don’t</h3>
              <List items={DISCLOSURE_POLICY.pleaseDont} />
            </div>
          </div>
          <p className="mt-5 text-[15px] leading-relaxed text-ds-ink-muted">
            {DISCLOSURE_POLICY.commitment} {DISCLOSURE_POLICY.bounty}
          </p>
          <p className="mt-3 text-[15px] leading-relaxed text-ds-ink-muted">
            <span className="font-semibold text-ds-ink">Safe harbour.</span> {DISCLOSURE_POLICY.safeHarbor.text}{' '}
            <Badge tone="neutral">{DISCLOSURE_POLICY.safeHarbor.note}</Badge>
          </p>
          <p className="mt-5 text-[15px]">
            <a className={LINK} href={SECURITY_MD_URL} rel="noopener noreferrer">
              Read our full security policy (SECURITY.md)
            </a>
          </p>
        </Card>
      </Section>
    </article>
  );
}
