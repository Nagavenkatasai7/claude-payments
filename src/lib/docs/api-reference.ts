import type { HttpMethod, SpecOperation } from '@/lib/openapi/types';

// UI redesign M4 PR-4: the pure helpers behind the partner API reference page. Everything they
// print comes from openapi.yaml (src/lib/openapi/load-spec.ts). They return bare anchor ids,
// never page URLs: the page builds its own links.

export interface ReferenceGroup {
  tag: string;
  operations: SpecOperation[];
}

const METHOD_ORDER: Record<HttpMethod, number> = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4 };
// Plain code-unit order (locale-independent, so the page is identical on every build machine).
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Operations grouped by their first tag, in the document's `tags` order; within a group by path,
 * then GET < POST < PUT. A tag with no operations is omitted. An operation whose tag the document
 * does not list THROWS (fails the build) rather than silently vanishing from the reference.
 */
export function groupByTag(ops: SpecOperation[], tagOrder: string[]): ReferenceGroup[] {
  for (const op of ops) {
    if (!tagOrder.includes(op.tag)) throw new Error(`api-reference: ${op.method} ${op.path} has unlisted tag ${op.tag}`);
  }
  return tagOrder
    .map((tag) => ({
      tag,
      operations: ops
        .filter((o) => o.tag === tag)
        .sort((a, b) => byCodeUnit(a.path, b.path) || METHOD_ORDER[a.method] - METHOD_ORDER[b.method]),
    }))
    .filter((g) => g.operations.length > 0);
}

/** A stable fragment id, e.g. POST /transactions/{id}/confirm → post-transactions-id-confirm. */
export function operationAnchor(op: SpecOperation): string {
  return `${op.method.toLowerCase()}-${op.path.replace(/[{}]/g, '').replace(/\//g, '-').replace(/^-/, '')}`;
}

/** A stable fragment id for a component schema, e.g. Transaction → schema-transaction. */
export function schemaAnchor(name: string): string {
  return `schema-${name.toLowerCase()}`;
}

/** A JSON example as the page prints it. */
export function formatExample(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// Inside a single-quoted shell string a ' closes the string: write it as '\''.
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A copy-paste curl for one operation. Keys are placeholders only: sandbox operations use the
 * $SMARTREMIT_TEST_KEY; operations a test key cannot call use $SMARTREMIT_LIVE_KEY (paste-ready either way). Required header
 * parameters (the Idempotency-Key on the mint) get a fresh UUID; path parameters stay as {name}.
 */
export function curlExample(op: SpecOperation, serverUrl: string): string {
  const lines = [`curl -X ${op.method} ${shellQuote(`${serverUrl}${op.path}`)}`];
  lines.push(op.sandbox ? '-H "Authorization: Bearer $SMARTREMIT_TEST_KEY"' : '-H "Authorization: Bearer $SMARTREMIT_LIVE_KEY"');
  for (const p of op.parameters) {
    if (p.in === 'header' && p.required) lines.push(`-H "${p.name}: $(uuidgen)"`);
  }
  if (op.requestExample !== null) {
    lines.push(`-H ${shellQuote('Content-Type: application/json')}`);
    lines.push(`-d ${shellQuote(formatExample(op.requestExample))}`);
  }
  return lines.join(' \\\n  ');
}
