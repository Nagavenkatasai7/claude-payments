import { describe, it, expect } from 'vitest';
import { loadPartnerOpenApiDocument } from '@/lib/openapi/load-spec';
import type { SpecOperation } from '@/lib/openapi/types';

// UI redesign M4 PR-4: the pure helpers behind the /docs-next API reference (grouping, stable
// anchors, the curl example). Everything they print comes from openapi.yaml.

const doc = loadPartnerOpenApiDocument();
const TAGS = doc.tags.map((t) => t.name);
const op = (id: string) => doc.operations.find((o) => o.operationId === id)!;

describe('groupByTag', () => {
  it('puts all 11 operations in 6 groups, in the openapi tags order', async () => {
    const { groupByTag } = await import('@/lib/docs/api-reference');
    const groups = groupByTag(doc.operations, TAGS);
    expect(groups.map((g) => g.tag)).toEqual(['Corridors', 'Quotes', 'Beneficiaries', 'Transactions', 'Rates', 'Settlements']);
    expect(groups.reduce((n, g) => n + g.operations.length, 0)).toBe(11);
  });

  it('orders each group by path (code units), then GET < POST < PUT', async () => {
    const { groupByTag } = await import('@/lib/docs/api-reference');
    const flat = groupByTag(doc.operations, TAGS).flatMap((g) => g.operations.map((o) => `${o.method} ${o.path}`));
    expect(flat).toEqual([
      'GET /corridors',
      'POST /quote',
      'POST /beneficiaries',
      'POST /beneficiaries/validate',
      'GET /transactions',
      'POST /transactions',
      'GET /transactions/{id}',
      'POST /transactions/{id}/confirm',
      'GET /rates',
      'PUT /rates',
      'GET /settlements',
    ]);
  });

  it('throws when an operation carries a tag the document does not list (never drops one)', async () => {
    const { groupByTag } = await import('@/lib/docs/api-reference');
    const stray = { ...op('listCorridors'), tag: 'Nope' } as SpecOperation;
    expect(() => groupByTag([...doc.operations, stray], TAGS)).toThrow(/Nope/);
  });

  it('omits a listed tag with no operations', async () => {
    const { groupByTag } = await import('@/lib/docs/api-reference');
    expect(groupByTag([op('listCorridors')], TAGS).map((g) => g.tag)).toEqual(['Corridors']);
  });
});

describe('operationAnchor', () => {
  it('is stable: method plus the path with braces dropped and slashes as dashes', async () => {
    const { operationAnchor } = await import('@/lib/docs/api-reference');
    expect(Object.fromEntries(doc.operations.map((o) => [o.operationId, operationAnchor(o)]))).toEqual({
      listCorridors: 'get-corridors',
      createQuote: 'post-quote',
      validateBeneficiary: 'post-beneficiaries-validate',
      createBeneficiary: 'post-beneficiaries',
      createTransaction: 'post-transactions',
      listTransactions: 'get-transactions',
      getTransaction: 'get-transactions-id',
      confirmTransaction: 'post-transactions-id-confirm',
      pushRate: 'put-rates',
      listRates: 'get-rates',
      listSettlements: 'get-settlements',
    });
  });
  it('is unique across the spec', async () => {
    const { operationAnchor } = await import('@/lib/docs/api-reference');
    const ids = doc.operations.map(operationAnchor);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('schemaAnchor is schema-<lowercase name>', async () => {
    const { schemaAnchor } = await import('@/lib/docs/api-reference');
    expect(schemaAnchor('Transaction')).toBe('schema-transaction');
  });
});

describe('curlExample', () => {
  it('never contains a live key or anything that looks like a real key', async () => {
    const { curlExample } = await import('@/lib/docs/api-reference');
    for (const o of doc.operations) {
      const c = curlExample(o, doc.serverUrl);
      expect(c).not.toContain('sr_live_');
      expect(c).not.toMatch(/sr_(live|test)_[A-Za-z0-9]/);
    }
  });

  it('uses a test-key variable for sandbox operations and a live-key variable for live-only ones', async () => {
    const { curlExample } = await import('@/lib/docs/api-reference');
    expect(curlExample(op('createQuote'), doc.serverUrl)).toContain('-H "Authorization: Bearer $SMARTREMIT_TEST_KEY"');
    for (const id of ['createBeneficiary', 'pushRate', 'listRates', 'listSettlements']) {
      const c = curlExample(op(id), doc.serverUrl);
      expect(c).toContain('-H "Authorization: Bearer $SMARTREMIT_LIVE_KEY"');
      expect(c).not.toContain('sr_test_');
    }
  });

  it('sends the Idempotency-Key header only for createTransaction (derived from the required header params)', async () => {
    const { curlExample } = await import('@/lib/docs/api-reference');
    const withHeader = doc.operations.filter((o) => curlExample(o, doc.serverUrl).includes('Idempotency-Key')).map((o) => o.operationId);
    expect(withHeader).toEqual(['createTransaction']);
    expect(curlExample(op('createTransaction'), doc.serverUrl)).toContain('-H "Idempotency-Key: $(uuidgen)"');
  });

  it('targets the server URL with the method and path, and sends the example body as JSON', async () => {
    const { curlExample } = await import('@/lib/docs/api-reference');
    const quote = curlExample(op('createQuote'), doc.serverUrl);
    expect(quote.split('\n')[0]).toBe("curl -X POST 'https://smartremit.ai/api/partner/v1/quote' \\");
    expect(quote).toContain("-H 'Content-Type: application/json'");
    const body = /-d '([\s\S]*)'$/.exec(quote)![1];
    expect(JSON.parse(body)).toEqual(op('createQuote').requestExample);
    const get = curlExample(op('listCorridors'), doc.serverUrl);
    expect(get).toBe("curl -X GET 'https://smartremit.ai/api/partner/v1/corridors' \\\n  -H \"Authorization: Bearer $SMARTREMIT_TEST_KEY\"");
  });

  it("escapes a single quote in the body so the shell string stays closed", async () => {
    const { curlExample } = await import('@/lib/docs/api-reference');
    const o = { ...op('createQuote'), requestExample: { note: "it's" } } as SpecOperation;
    expect(curlExample(o, doc.serverUrl)).toContain(`"note": "it'\\''s"`);
  });
});

describe('formatExample', () => {
  it('pretty-prints JSON with two-space indent', async () => {
    const { formatExample } = await import('@/lib/docs/api-reference');
    expect(formatExample({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
