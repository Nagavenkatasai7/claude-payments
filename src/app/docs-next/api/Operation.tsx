import type { ReactNode } from 'react';
import { Badge, type Tone } from '@/components/ds';
import { curlExample, formatExample, operationAnchor, schemaAnchor } from '@/lib/docs/api-reference';
import type { HttpMethod, SpecOperation } from '@/lib/openapi/types';

// One Partner API operation, rendered at build from openapi.yaml. Server component: no client JS.
// Wide content (tables, JSON, curl) scrolls inside its own box, so the page never scrolls sideways
// on a phone.

const METHOD_TONE: Record<HttpMethod, Tone> = { GET: 'info', POST: 'success', PUT: 'warning', PATCH: 'warning', DELETE: 'danger' };
const H4 = 'mt-6 text-[13px] font-bold uppercase tracking-[0.08em] text-ds-ink-faint';
const CODE = 'rounded-ds-focus bg-ds-tint px-1 py-0.5 font-mono text-[0.9em] text-ds-ink';
const TH = 'whitespace-nowrap border-b border-ds-border px-4 py-2 font-semibold text-ds-ink';
const TD = 'border-b border-ds-border px-4 py-2 align-top text-ds-ink-muted';
const LINK = 'font-semibold text-ds-primary hover:underline';

export function MethodBadge({ method }: { method: HttpMethod }) {
  return (
    <Badge tone={METHOD_TONE[method]} className="font-mono">
      {method}
    </Badge>
  );
}

/** A table that scrolls inside its box on a narrow screen instead of squeezing its columns. */
export function ScrollTable({ caption, head, children }: { caption: string; head: string[]; children: ReactNode }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-ds-inner border border-ds-border bg-ds-surface">
      <table className="w-full min-w-[520px] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
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

/** A preformatted block (JSON or shell); long lines scroll inside the block. */
export function CodeBlock({ label, children }: { label: string; children: string }) {
  return (
    <pre
      aria-label={label}
      className="mt-3 overflow-x-auto rounded-ds-inner border border-ds-border bg-ds-surface p-4 font-mono text-[13px] leading-relaxed text-ds-ink"
    >
      <code>{children}</code>
    </pre>
  );
}

function ResponseBody({ op, status }: { op: SpecOperation; status: number }) {
  const body = op.responseBodies[status];
  if (!body || body.contentTypes.length === 0) return <span aria-label="No body">—</span>;
  return (
    <span className="flex flex-col gap-1">
      {body.schema ? (
        <a className={LINK} href={`#${schemaAnchor(body.schema)}`}>
          {body.schema}
        </a>
      ) : body.example !== null ? (
        <span>See the example below</span>
      ) : null}
      <span className="whitespace-nowrap font-mono text-[12.5px] text-ds-ink-faint">{body.contentTypes.join(', ')}</span>
    </span>
  );
}

export function Operation({ op, serverUrl }: { op: SpecOperation; serverUrl: string }) {
  const examples = op.statuses.filter((s) => op.responseBodies[s]?.example != null);
  return (
    <section id={operationAnchor(op)} data-op={op.operationId} className="scroll-mt-24 border-t border-ds-border pt-8">
      <h3 className="text-lg font-semibold text-ds-ink">{op.summary}</h3>
      <p className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <MethodBadge method={op.method} />{' '}
        <code className="min-w-0 break-all font-mono text-[15px] font-semibold text-ds-ink">{op.path}</code>
      </p>
      {op.description ? <p className="mt-3 max-w-[72ch] leading-relaxed text-ds-ink-muted">{op.description}</p> : null}
      <dl className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px]">
        <div className="flex flex-wrap items-center gap-2">
          <dt className="font-semibold text-ds-ink">Scope</dt>
          <dd>
            <code className={CODE}>{op.scope}</code>
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="sr-only">Sandbox</dt>
          <dd>
            <Badge tone={op.sandbox ? 'success' : 'neutral'}>
              <span aria-hidden="true">{op.sandbox ? '✓' : '✕'}</span>
              {`Sandbox keys: ${op.sandbox ? 'yes' : 'no'}`}
            </Badge>
          </dd>
        </div>
      </dl>

      {op.parameters.length > 0 ? (
        <>
          <h4 className={H4}>Parameters</h4>
          <ScrollTable caption={`${op.summary}: parameters`} head={['Name', 'In', 'Required', 'Description']}>
            {op.parameters.map((p) => (
              <tr key={`${p.in}:${p.name}`}>
                <td className={TD}>
                  <code className={`${CODE} whitespace-nowrap`}>{p.name}</code>
                </td>
                <td className={TD}>{p.in}</td>
                <td className={TD}>{p.required ? 'Yes' : 'No'}</td>
                <td className={TD}>{p.description}</td>
              </tr>
            ))}
          </ScrollTable>
        </>
      ) : null}

      {op.requestExample !== null ? (
        <>
          <h4 className={H4}>Request body{op.requestBodyRequired ? ' (required, JSON)' : ' (JSON)'}</h4>
          <CodeBlock label={`${op.summary}: example request body`}>{formatExample(op.requestExample)}</CodeBlock>
        </>
      ) : null}

      <h4 className={H4}>Responses</h4>
      <ScrollTable caption={`${op.summary}: responses`} head={['Status', 'Meaning', 'Body']}>
        {op.statuses.map((s) => (
          <tr key={s} data-status={s}>
            <td className={TD}>
              <code className={CODE}>{s}</code>
            </td>
            <td className={TD}>{op.responses[s]}</td>
            <td className={TD}>
              <ResponseBody op={op} status={s} />
            </td>
          </tr>
        ))}
      </ScrollTable>

      {examples.map((s) => (
        <div key={s}>
          <h4 className={H4}>Example {s} response</h4>
          <CodeBlock label={`${op.summary}: example ${s} response`}>{formatExample(op.responseBodies[s].example)}</CodeBlock>
        </div>
      ))}

      <h4 className={H4}>curl</h4>
      <CodeBlock label={`${op.summary}: curl example`}>{curlExample(op, serverUrl)}</CodeBlock>
    </section>
  );
}
