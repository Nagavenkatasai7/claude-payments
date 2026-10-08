import { describe, it, expect } from 'vitest';

// Program: UI redesign M4. openapi.yaml is the hand-maintained source of truth
// for /api/partner/v1. This test enumerates EVERY route file and fails on drift
// in EITHER direction: an undocumented route/method, a documented operation
// with no route, a scope mismatch, a status-code mismatch, or a sandbox flag
// that disagrees with the test-key ceiling. It runs in every `ci / ci` shard set.

const key = (o: { method: string; path: string }) => `${o.method} ${o.path}`;

describe('openapi.yaml ⇄ src/app/api/partner/v1 drift', () => {
  it('documents exactly the implemented operations (both directions)', async () => {
    const { inventoryPartnerRoutes } = await import('@/lib/openapi/route-inventory');
    const { loadPartnerOpenApi } = await import('@/lib/openapi/load-spec');
    const impl = inventoryPartnerRoutes().map(key).sort();
    const spec = loadPartnerOpenApi().map(key).sort();
    expect({ undocumented: impl.filter((k) => !spec.includes(k)), unimplemented: spec.filter((k) => !impl.includes(k)) })
      .toEqual({ undocumented: [], unimplemented: [] });
  });

  it('matches scope and status codes per operation', async () => {
    const { inventoryPartnerRoutes } = await import('@/lib/openapi/route-inventory');
    const { loadPartnerOpenApi } = await import('@/lib/openapi/load-spec');
    const spec = new Map(loadPartnerOpenApi().map((o) => [key(o), o]));
    for (const op of inventoryPartnerRoutes()) {
      const doc = spec.get(key(op));
      expect(doc, key(op)).toBeDefined();
      expect({ op: key(op), scope: doc!.scope }).toEqual({ op: key(op), scope: op.scope });
      expect({ op: key(op), statuses: doc!.statuses }).toEqual({ op: key(op), statuses: op.statuses });
    }
  });

  it('uses only real scopes, and the sandbox flag equals the test-key ceiling', async () => {
    const { loadPartnerOpenApi } = await import('@/lib/openapi/load-spec');
    const { ALL_SCOPES, scopesForMode } = await import('@/lib/partner-api-scopes');
    const test = scopesForMode('test');
    for (const op of loadPartnerOpenApi()) {
      expect(ALL_SCOPES as readonly string[]).toContain(op.scope);
      expect({ op: key(op), sandbox: op.sandbox })
        .toEqual({ op: key(op), sandbox: (test as string[]).includes(op.scope) });
    }
  });

  it('never documents a 500 or a malformed-JSON 400 (readJson swallows bad JSON)', async () => {
    const { loadPartnerOpenApi } = await import('@/lib/openapi/load-spec');
    for (const op of loadPartnerOpenApi()) {
      expect(op.statuses).not.toContain(500);
      if (op.responses[400]) expect(op.responses[400]).not.toMatch(/malformed|invalid json/i);
    }
  });

  it('the POST /transactions operation documents the required Idempotency-Key header', async () => {
    const { loadPartnerOpenApi } = await import('@/lib/openapi/load-spec');
    const mint = loadPartnerOpenApi().find((o) => key(o) === 'POST /transactions')!;
    expect(mint.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }));
  });

  // Required purpose (owner decision 2026-10-08): the API reference renders the documented example
  // as the copyable request, so an example without a valid purpose would 422; the schema and the
  // 422 text name the 8 values.
  it('the POST /transactions example carries a valid purpose; the Transaction schema and the 422 document it', async () => {
    const { loadPartnerOpenApi, loadPartnerOpenApiDocument } = await import('@/lib/openapi/load-spec');
    const { TRANSFER_PURPOSES } = await import('@/lib/purpose-codes');
    const mint = loadPartnerOpenApi().find((o) => key(o) === 'POST /transactions')!;
    expect(TRANSFER_PURPOSES as readonly string[]).toContain((mint.requestExample as Record<string, unknown>).purpose);
    for (const p of TRANSFER_PURPOSES) expect(mint.responses[422]).toContain(p);
    expect(mint.description).toMatch(/purpose is required/);
    const tx = loadPartnerOpenApiDocument().schemas.find((s) => s.name === 'Transaction')!;
    expect(tx.fields.find((f) => f.name === 'purpose')).toMatchObject({ type: 'string | null' });
  });
});
