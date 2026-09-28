import type { ReactNode } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ds';
import { FACTS, type FactName } from '@/content/docs/facts';
import { guideBySlug } from '@/content/docs/registry';
import { TEMPLATES, type TemplateEntry } from '@/content/docs/whatsapp-template-catalog';
import { loadPartnerOpenApi } from '@/lib/openapi/load-spec';

// UI redesign M4 PR-3: the code-backed blocks the partner guides render. src/mdx-components.tsx
// exposes them to every guide, so no .mdx file imports anything (the content guard forbids it).
// Server components only: the guides are prerendered at build and ship no client JS. Every
// unknown name THROWS, which fails `next build` instead of publishing a stale or broken page.

const CODE = 'rounded-ds-focus bg-ds-tint px-1 py-0.5 font-mono text-[0.9em] text-ds-ink break-words';
const H3 = 'mt-8 text-lg font-semibold text-ds-ink';

/** A value from facts.ts. Numbers print bare; strings and array items print as code. */
export function Fact({ name }: { name: FactName }) {
  if (!Object.hasOwn(FACTS, name)) throw new Error(`<Fact>: unknown fact "${String(name)}"`);
  const value: unknown = FACTS[name];
  if (typeof value === 'number') return <>{String(value)}</>;
  if (typeof value === 'string') return <code className={CODE}>{value}</code>;
  if (Array.isArray(value))
    return (
      <>
        {value.map((v: string, i) => (
          <span key={v}>
            {i > 0 ? ', ' : null}
            <code className={CODE}>{v}</code>
          </span>
        ))}
      </>
    );
  throw new Error(`<Fact>: unsupported value type for "${String(name)}"`);
}

/** A link to another guide. The slug must be registered (src/content/docs/registry.ts). */
export function GuideLink({ slug, children }: { slug: string; children?: ReactNode }) {
  if (!guideBySlug(slug)) throw new Error(`<GuideLink>: unknown guide "${slug}"`);
  return (
    <Link href={`/docs-next/${slug}`} className="font-semibold text-ds-primary hover:underline">
      {children}
    </Link>
  );
}

/** Every status each Partner API operation can return, straight from openapi.yaml. */
export function ErrorStatusTable() {
  const ops = loadPartnerOpenApi();
  return (
    <div className="mt-4 overflow-x-auto rounded-ds-inner border border-ds-border bg-ds-surface">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            <th scope="col" className="whitespace-nowrap border-b border-ds-border px-4 py-2 font-semibold text-ds-ink">Endpoint</th>
            <th scope="col" className="whitespace-nowrap border-b border-ds-border px-4 py-2 font-semibold text-ds-ink">Status codes</th>
          </tr>
        </thead>
        <tbody>
          {ops.map((op) => (
            <tr data-op={op.operationId} key={op.operationId}>
              <td className="border-b border-ds-border px-4 py-2 align-top">
                <span className="block font-semibold text-ds-ink">{op.summary}</span>
                <code className="font-mono text-[12.5px] text-ds-ink-muted break-words">
                  {`${op.method} /api/partner/v1${op.path}`}
                </code>
              </td>
              <td className="border-b border-ds-border px-4 py-2 align-top">
                <ul className="flex flex-wrap gap-1.5">
                  {op.statuses.map((s) => (
                    <li key={s} data-status={s} title={op.responses[s]}>
                      <code className={CODE}>{s}</code>
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function buttonText(b: NonNullable<TemplateEntry['button']>): string {
  if (b.kind === 'copy-code') return 'Copy code';
  return b.urlPattern ? `${b.label}: ${b.urlPattern}` : `${b.label}: Published when this template goes live`;
}

function TemplateCard({ t }: { t: TemplateEntry }) {
  const row = 'grid gap-1 sm:grid-cols-[120px_1fr]';
  const dt = 'text-[12.5px] font-semibold uppercase tracking-[0.06em] text-ds-ink-subtle';
  return (
    <li data-template={t.name} className="rounded-ds-inner border border-ds-border bg-ds-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-[15px] font-semibold text-ds-ink break-words">{t.name}</code>
        <Badge tone="neutral">{t.category}</Badge>
        {t.nameSource === 'configured' ? <Badge tone="info">Optional (configured)</Badge> : null}
      </div>
      <p className="mt-2 text-[14px] text-ds-ink-muted">{t.purpose}</p>
      <dl className="mt-3 flex flex-col gap-2 text-[14px]">
        <div className={row}>
          <dt className={dt}>Body</dt>
          <dd>
            <pre className="whitespace-pre-wrap rounded-ds-focus bg-ds-tint p-2 font-mono text-[13px] text-ds-ink break-words">{t.body}</pre>
          </dd>
        </div>
        {t.footer ? (
          <div className={row}>
            <dt className={dt}>Footer</dt>
            <dd className="text-ds-ink">{t.footer}</dd>
          </div>
        ) : null}
        {t.button ? (
          <div className={row}>
            <dt className={dt}>Button</dt>
            <dd className="text-ds-ink break-words">{buttonText(t.button)}</dd>
          </div>
        ) : null}
        <div className={row}>
          <dt className={dt}>Language</dt>
          <dd className="text-ds-ink">{t.language}</dd>
        </div>
        <div className={row}>
          <dt className={dt}>Variables</dt>
          <dd className="text-ds-ink">
            {t.paramCount}
            {t.samples?.length ? <span className="text-ds-ink-muted"> (samples: {t.samples.join(' · ')})</span> : null}
          </dd>
        </div>
      </dl>
    </li>
  );
}

/** The WhatsApp templates a partner submits for its own number, split by whether they are sent today. */
export function TemplateCatalog() {
  const today = TEMPLATES.filter((t) => t.sentToday);
  const planned = TEMPLATES.filter((t) => !t.sentToday);
  return (
    <div>
      <h3 className={H3}>Sent from your number today</h3>
      <ul className="mt-4 flex flex-col gap-3">
        {today.map((t) => (
          <TemplateCard key={t.name} t={t} />
        ))}
      </ul>
      <h3 className={H3}>Planned, not sent yet</h3>
      <p className="mt-2 text-ds-ink-muted">Do not submit these until this guide says they are sent.</p>
      <ul className="mt-4 flex flex-col gap-3">
        {planned.map((t) => (
          <TemplateCard key={t.name} t={t} />
        ))}
      </ul>
    </div>
  );
}
