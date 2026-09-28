import type { Metadata } from 'next';
import { Card, EmptyState, PageHeader } from '@/components/ds';
import { groupByTag, operationAnchor, schemaAnchor } from '@/lib/docs/api-reference';
import { loadPartnerOpenApiDocument } from '@/lib/openapi/load-spec';
import { MethodBadge, Operation, ScrollTable } from './Operation';

// UI redesign M4 PR-4: the Partner API reference, rendered from openapi.yaml at BUILD time.
// force-static prerenders it (node_modules/next/dist/docs/01-app/02-guides/
// caching-without-cache-components.md:88,104; cacheComponents is off in next.config.ts), so the
// fs read of openapi.yaml happens during `next build` and the route ships as static HTML with no
// client JS. The layout's metadata keeps the preview out of search (this file sets none of that).
export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'API reference',
  description: 'Every SmartRemit Partner API operation: scopes, sandbox availability, parameters, examples and status codes.',
};

const CODE = 'rounded-ds-focus bg-ds-tint px-1 py-0.5 font-mono text-[0.9em] text-ds-ink break-all';
const TD = 'border-b border-ds-border px-4 py-2 align-top text-ds-ink-muted';

export default function ApiReferencePage() {
  const doc = loadPartnerOpenApiDocument();
  const groups = groupByTag(
    doc.operations,
    doc.tags.map((t) => t.name),
  );
  const tagInfo = new Map(doc.tags.map((t) => [t.name, t.description]));
  return (
    <article className="break-words">
      <PageHeader
        title="API reference"
        sub="Every Partner API operation, generated from the published OpenAPI description: the scope each one needs, whether sandbox keys can call it, and every status it can return."
      />

      <Card className="mt-6 p-5 sm:p-6">
        <dl className="flex flex-col gap-3 text-[15px]">
          <div>
            <dt className="font-semibold text-ds-ink">Base URL</dt>
            <dd className="mt-1">
              <code className={CODE}>{doc.serverUrl}</code>
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-ds-ink">Authentication</dt>
            <dd className="mt-1 text-ds-ink-muted">
              <code className={CODE}>Authorization: Bearer sr_test_…</code> with a sandbox key, or your live key after go-live. The examples below read the key from{' '}
              <code className={CODE}>$SMARTREMIT_TEST_KEY</code> or <code className={CODE}>$SMARTREMIT_LIVE_KEY</code>: export it in your
              shell first.
            </dd>
          </div>
        </dl>
        {doc.description ? <p className="mt-4 max-w-[72ch] leading-relaxed text-ds-ink-muted">{withInlineCode(doc.description)}</p> : null}
      </Card>

      {groups.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No operations published yet" body="The Partner API description has no operations. Check back soon." />
        </div>
      ) : (
        <>
          <nav aria-label="Operations" className="mt-8">
            <h2 className="text-xl font-bold tracking-[-0.015em] text-ds-ink">Operations</h2>
            <ul className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
              {groups.map((g) => (
                <li key={g.tag} className="min-w-0">
                  <a className="font-semibold text-ds-ink hover:text-ds-primary" href={`#${tagAnchor(g.tag)}`}>
                    {g.tag}
                  </a>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {g.operations.map((op) => (
                      <li key={op.operationId} className="min-w-0">
                        <a className="flex min-w-0 flex-wrap items-center gap-2 text-[14px] text-ds-ink-muted hover:text-ds-primary" href={`#${operationAnchor(op)}`}>
                          <MethodBadge method={op.method} />{' '}
                          <code className="min-w-0 break-all font-mono">{op.path}</code>
                        </a>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </nav>

          {groups.map((g) => (
            <div key={g.tag} id={tagAnchor(g.tag)} className="mt-12 scroll-mt-24">
              <h2 className="text-2xl font-bold tracking-[-0.015em] text-ds-ink">{g.tag}</h2>
              {tagInfo.get(g.tag) ? <p className="mt-2 text-ds-ink-muted">{tagInfo.get(g.tag)}</p> : null}
              <div className="mt-6 flex flex-col gap-10">
                {g.operations.map((op) => (
                  <Operation key={op.operationId} op={op} serverUrl={doc.serverUrl} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {doc.schemas.length > 0 ? (
        <div id="schemas" className="mt-12 scroll-mt-24">
          <h2 className="text-2xl font-bold tracking-[-0.015em] text-ds-ink">Schemas</h2>
          <div className="mt-6 flex flex-col gap-10">
            {doc.schemas.map((s) => (
              <section id={schemaAnchor(s.name)} key={s.name} className="scroll-mt-24 border-t border-ds-border pt-8">
                <h3 className="text-lg font-semibold text-ds-ink">{s.name}</h3>
                <ScrollTable caption={`${s.name} fields`} head={['Field', 'Type', 'Required', 'Description']}>
                  {s.fields.map((f) => (
                    <tr key={f.name}>
                      <td className={TD}>
                        <code className="whitespace-nowrap rounded-ds-focus bg-ds-tint px-1 py-0.5 font-mono text-[0.9em] text-ds-ink">{f.name}</code>
                      </td>
                      <td className={`${TD} whitespace-nowrap font-mono text-[13px]`}>{f.format ? `${f.type} (${f.format})` : f.type}</td>
                      <td className={TD}>{f.required ? 'Yes' : 'No'}</td>
                      <td className={TD}>{f.description}</td>
                    </tr>
                  ))}
                </ScrollTable>
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function tagAnchor(tag: string): string {
  return `tag-${tag.toLowerCase()}`;
}

/** The spec's prose marks code with backticks (as markdown does): render those spans as code. */
function withInlineCode(text: string) {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className={CODE}>
        {part}
      </code>
    ) : (
      part
    ),
  );
}
