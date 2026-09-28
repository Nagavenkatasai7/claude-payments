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
      { method: 'POST', scope: 'things:write', serviceFn: 'createThing', viaSvc: true, directStatuses: [] },
      { method: 'GET', scope: 'things:read', serviceFn: 'listThings', viaSvc: true, directStatuses: [] },
    ]);
  });

  it('treats a NextResponse.json with no status as a direct 200 (the service fn is still resolved)', async () => {
    const { parseRouteSource } = await import('@/lib/openapi/route-inventory');
    // Like corridors/route.ts:9, which resolves to listCorridors (no err/ok literals) plus a direct 200.
    expect(parseRouteSource(ROUTE_DIRECT, 'f')).toEqual([
      { method: 'GET', scope: 'things:read', serviceFn: 'listThings', viaSvc: false, directStatuses: [200] },
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

// ── Review round 1 (PR #370): pass-through shapes and escape hatches ─────────

const PASS_THROUGH = `
const ok = (status, data) => ({ ok: true, status, data });
const err = (status, error) => ({ ok: false, status, error });
async function inner() { return err(409, 'x'); }
export async function outer() {
  const r = await inner();
  if (!r.ok) return r;
  return ok(200, {});
}
export async function created() { return ok(201, {}); }
export async function delegates() {
  if (Math.random() > 2) return;
  return created();
}
export async function early() {
  return ok(200, {});
}
function helperAfter() { return err(418, 'teapot'); }
const arrowAfter = () => err(451, 'x');
export function plain() { return { a: 1 }; }
`;

describe('serviceFunctionStatuses (round 1: no silent under-count)', () => {
  it('FAILS CLOSED when a status is passed through from a private helper', async () => {
    const { serviceFunctionStatuses, InventoryError } = await import('@/lib/openapi/route-inventory');
    expect(() => serviceFunctionStatuses(PASS_THROUGH, 'outer')).toThrow(InventoryError);
  });
  it('FAILS CLOSED when the function delegates to another exported function', async () => {
    const { serviceFunctionStatuses, InventoryError } = await import('@/lib/openapi/route-inventory');
    expect(() => serviceFunctionStatuses(PASS_THROUGH, 'delegates')).toThrow(InventoryError);
  });
  it('ends the span at the next top-level function or arrow, exported or not', async () => {
    const { serviceFunctionStatuses } = await import('@/lib/openapi/route-inventory');
    expect(serviceFunctionStatuses(PASS_THROUGH, 'early')).toEqual([200]);
  });
  it('allows a bare return; and, when not strict, a plain-object return', async () => {
    const { serviceFunctionStatuses, InventoryError } = await import('@/lib/openapi/route-inventory');
    expect(serviceFunctionStatuses('export function a() { if (x) return; return ok(204, null); }', 'a')).toEqual([204]);
    expect(serviceFunctionStatuses(PASS_THROUGH, 'plain', { strict: false })).toEqual([]);
    expect(() => serviceFunctionStatuses(PASS_THROUGH, 'plain')).toThrow(InventoryError);
  });
});

describe('parseRouteSource (round 1: escape hatches)', () => {
  it('FAILS CLOSED on a helper function, an arrow or a Response built before the first handler', async () => {
    const { parseRouteSource, InventoryError } = await import('@/lib/openapi/route-inventory');
    const split = ROUTE_SVC.indexOf('export async function POST');
    const withPre = (pre: string) => ROUTE_SVC.slice(0, split) + pre + '\n' + ROUTE_SVC.slice(split);
    expect(() => parseRouteSource(withPre('function helper() { return 1; }'), 'f')).toThrow(InventoryError);
    expect(() => parseRouteSource(withPre('const helper = async () => 1;'), 'f')).toThrow(InventoryError);
    expect(() => parseRouteSource(withPre("const gone = new Response(null, { status: 410 });"), 'f')).toThrow(InventoryError);
    expect(() => parseRouteSource(withPre("const gone = NextResponse.json({});"), 'f')).toThrow(InventoryError);
    // Comments before the first handler are fine, even when they mention these words.
    expect(() => parseRouteSource(withPre('// a function => Response.json( note'), 'f')).not.toThrow();
  });
  it('FAILS CLOSED on .redirect( and Response.error( in a handler', async () => {
    const { parseRouteSource, InventoryError } = await import('@/lib/openapi/route-inventory');
    const redirect = ROUTE_SVC.replace('if (!g.ok) return g.response;', "if (!g.ok) return NextResponse.redirect('/x');");
    expect(() => parseRouteSource(redirect, 'f')).toThrow(InventoryError);
    const error = ROUTE_SVC.replace('if (!g.ok) return g.response;', 'if (!g.ok) return Response.error();');
    expect(() => parseRouteSource(error, 'f')).toThrow(InventoryError);
  });
});

describe('guardStatusesFromSource (round 1: guard pass-through)', () => {
  const guard = (s: string) => `
export async function guardPartner(req, scope) {
  const auth = await authenticatePartner(req);
  if (!auth.ok) return { ok: false, response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  if (x) return { ok: false, response: NextResponse.json({}, { status: ${s} }) };
}
export function svcResponse(result) { return NextResponse.json({}, { status: result.status }); }
`;
  const auth = 'export interface R { status: number; }\nreturn { ok: false, status: 401 };';
  it('accepts literals and the auth.status pass-through, and ignores svcResponse', async () => {
    const { guardStatusesFromSource } = await import('@/lib/openapi/route-inventory');
    expect(guardStatusesFromSource(guard('429'), auth)).toEqual([401, 429]);
  });
  it('FAILS CLOSED on any other non-literal guard status, or a missing guardPartner', async () => {
    const { guardStatusesFromSource, InventoryError } = await import('@/lib/openapi/route-inventory');
    expect(() => guardStatusesFromSource(guard('code'), auth)).toThrow(InventoryError);
    expect(() => guardStatusesFromSource('export function other() {}', auth)).toThrow(InventoryError);
    expect(() => guardStatusesFromSource(guard('429'), 'return { status: s };')).toThrow(InventoryError);
  });
});
