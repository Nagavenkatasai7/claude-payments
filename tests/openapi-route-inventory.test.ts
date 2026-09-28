import { describe, it, expect } from 'vitest';

const SERVICE = `
const ok = <T>(status: number, data: T) => ({ ok: true, status, data });
const err = (status: number, error: string) => ({ ok: false, status, error });
export async function createThing(deps, body) {
  if (!body.a) return err(400, 'a is required.');
  if (body.b) return err(422, 'bad b');
  return ok(201, { id: 1 });
}
export function listThings() { return ok(200, []); }
export async function badThing(s) { return err(s, 'x'); }
`;

const ROUTE_SVC = `
import { type NextRequest } from 'next/server';
import { guardPartner, readJson, svcResponse } from '@/lib/partner-api';
import { createThing, listThings } from '@/lib/partner-api-service';
export async function POST(req: NextRequest) {
  const g = await guardPartner(req, 'things:write');
  if (!g.ok) return g.response;
  return svcResponse(await createThing(g.ctx.deps, await readJson(req)));
}
export async function GET(req: NextRequest) {
  const g = await guardPartner(req, 'things:read');
  if (!g.ok) return g.response;
  return svcResponse(await listThings());
}
`;

const ROUTE_DIRECT = `
import { NextResponse, type NextRequest } from 'next/server';
import { guardPartner } from '@/lib/partner-api';
import { listThings } from '@/lib/partner-api-service';
export async function GET(req: NextRequest) {
  const g = await guardPartner(req, 'things:read');
  if (!g.ok) return g.response;
  return NextResponse.json(listThings());
}
`;

describe('routePathFromFile', () => {
  it('maps route files to OpenAPI paths', async () => {
    const { routePathFromFile } = await import('@/lib/openapi/route-inventory');
    expect(routePathFromFile('/r/v1', '/r/v1/corridors/route.ts')).toBe('/corridors');
    expect(routePathFromFile('/r/v1', '/r/v1/transactions/[id]/confirm/route.ts')).toBe('/transactions/{id}/confirm');
    expect(routePathFromFile('/r/v1', '/r/v1/beneficiaries/validate/route.ts')).toBe('/beneficiaries/validate');
  });
});

describe('parseRouteSource', () => {
  it('reads each exported method, its literal scope and its one service call', async () => {
    const { parseRouteSource } = await import('@/lib/openapi/route-inventory');
    expect(parseRouteSource(ROUTE_SVC, 'f')).toEqual([
      { method: 'POST', scope: 'things:write', serviceFn: 'createThing', directStatuses: [] },
      { method: 'GET', scope: 'things:read', serviceFn: 'listThings', directStatuses: [] },
    ]);
  });

  it('treats a NextResponse.json with no status as a direct 200 (the service fn is still resolved)', async () => {
    const { parseRouteSource } = await import('@/lib/openapi/route-inventory');
    // Like corridors/route.ts:9, which resolves to listCorridors (no err/ok literals) plus a direct 200.
    expect(parseRouteSource(ROUTE_DIRECT, 'f')).toEqual([
      { method: 'GET', scope: 'things:read', serviceFn: 'listThings', directStatuses: [200] },
    ]);
  });

  it('FAILS CLOSED: a const-arrow handler', async () => {
    const { parseRouteSource, InventoryError } = await import('@/lib/openapi/route-inventory');
    const src = ROUTE_SVC + `\nexport const PUT = async (req) => new Response('x');\n`;
    expect(() => parseRouteSource(src, 'f')).toThrow(InventoryError);
  });

  it('FAILS CLOSED: a sync handler, a re-exported handler, or a default export', async () => {
    // Review round 1: a handler the head regex does not see must never be silently dropped.
    const { parseRouteSource, InventoryError } = await import('@/lib/openapi/route-inventory');
    expect(() => parseRouteSource(ROUTE_SVC + `\nexport function PATCH(req) { return new Response('x'); }\n`, 'f')).toThrow(InventoryError);
    expect(() => parseRouteSource(ROUTE_SVC + `\nexport { h as DELETE };\n`, 'f')).toThrow(InventoryError);
    expect(() => parseRouteSource(ROUTE_SVC + `\nexport default function h() {}\n`, 'f')).toThrow(InventoryError);
  });

  it('collects literal statuses from new Response(...) / Response.json(...) even beside svcResponse', async () => {
    const { parseRouteSource } = await import('@/lib/openapi/route-inventory');
    const src = ROUTE_SVC.replace("return svcResponse(await listThings());",
      "if (x) return new Response(null, { status: 204 });\n  return svcResponse(await listThings());");
    expect(parseRouteSource(src, 'f')[1]).toMatchObject({ method: 'GET', directStatuses: [204] });
  });

  it('FAILS CLOSED: a non-literal or missing scope', async () => {
    const { parseRouteSource, InventoryError } = await import('@/lib/openapi/route-inventory');
    expect(() => parseRouteSource(ROUTE_SVC.replace("'things:write'", 'SCOPE'), 'f')).toThrow(InventoryError);
    expect(() => parseRouteSource(ROUTE_SVC.replace("guardPartner(req, 'things:write')", 'other(req)'), 'f')).toThrow(InventoryError);
  });

  it('FAILS CLOSED: a non-literal direct status', async () => {
    const { parseRouteSource, InventoryError } = await import('@/lib/openapi/route-inventory');
    const src = ROUTE_DIRECT.replace('NextResponse.json(listThings())', 'NextResponse.json(listThings(), { status: code })');
    expect(() => parseRouteSource(src, 'f')).toThrow(InventoryError);
  });

  it('FAILS CLOSED: a svcResponse whose service function cannot be resolved', async () => {
    const { parseRouteSource, InventoryError } = await import('@/lib/openapi/route-inventory');
    const src = ROUTE_SVC.replace('createThing(g.ctx.deps', 'somethingElse(g.ctx.deps');
    expect(() => parseRouteSource(src, 'f')).toThrow(InventoryError);
  });
});

describe('serviceFunctionStatuses', () => {
  it('collects err()/ok() literal statuses inside the named function only', async () => {
    const { serviceFunctionStatuses } = await import('@/lib/openapi/route-inventory');
    expect(serviceFunctionStatuses(SERVICE, 'createThing')).toEqual([201, 400, 422]);
    expect(serviceFunctionStatuses(SERVICE, 'listThings')).toEqual([200]);
  });
  it('FAILS CLOSED on a non-literal status and on an unknown function', async () => {
    const { serviceFunctionStatuses, InventoryError } = await import('@/lib/openapi/route-inventory');
    expect(() => serviceFunctionStatuses(SERVICE, 'badThing')).toThrow(InventoryError);
    expect(() => serviceFunctionStatuses(SERVICE, 'nope')).toThrow(InventoryError);
  });
});

describe('guardStatusesFromSource (the real guard files)', () => {
  it('equals GUARD_STATUSES, so a new guard status breaks the build', async () => {
    const { readFileSync } = await import('node:fs');
    const { guardStatusesFromSource, GUARD_STATUSES } = await import('@/lib/openapi/route-inventory');
    const guard = readFileSync('src/lib/partner-api.ts', 'utf8');
    const auth = readFileSync('src/lib/partner-api-auth.ts', 'utf8');
    expect(guardStatusesFromSource(guard, auth)).toEqual([...GUARD_STATUSES]);
  });
});
