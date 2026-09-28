import { describe, it, expect } from 'vitest';

// Program: UI redesign M4 (PR-1). load-spec parses + validates openapi.yaml and
// fails LOUD on any shape it does not understand.

const MINI = `
openapi: 3.1.0
info: { title: t, version: '1' }
servers: [{ url: https://smartremit.ai/api/partner/v1 }]
tags: [{ name: Corridors }]
paths:
  /corridors:
    get:
      operationId: listCorridors
      summary: List corridors
      description: d
      tags: [Corridors]
      x-smartremit-scope: corridors:read
      x-smartremit-sandbox: true
      responses:
        '200': { description: OK }
        '401': { description: Missing or invalid key }
`;

describe('parseOpenApi', () => {
  it('returns one SpecOperation per path+method with numeric sorted statuses', async () => {
    const { parseOpenApi } = await import('@/lib/openapi/load-spec');
    const ops = parseOpenApi(MINI);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      path: '/corridors', method: 'GET', operationId: 'listCorridors', tag: 'Corridors',
      scope: 'corridors:read', sandbox: true, statuses: [200, 401],
    });
  });

  it('throws when an operation lacks x-smartremit-scope', async () => {
    const { parseOpenApi } = await import('@/lib/openapi/load-spec');
    expect(() => parseOpenApi(MINI.replace('x-smartremit-scope: corridors:read', ''))).toThrow(/x-smartremit-scope/);
  });

  it('throws when x-smartremit-sandbox is not a boolean', async () => {
    const { parseOpenApi } = await import('@/lib/openapi/load-spec');
    expect(() => parseOpenApi(MINI.replace('x-smartremit-sandbox: true', "x-smartremit-sandbox: 'yes'"))).toThrow(/x-smartremit-sandbox/);
  });

  it('throws on a non-3-digit response key and on a duplicate operationId', async () => {
    const { parseOpenApi } = await import('@/lib/openapi/load-spec');
    expect(() => parseOpenApi(MINI.replace("'401'", 'default'))).toThrow(/response/);
    const dup = MINI + `
  /corridors2:
    get:
      operationId: listCorridors
      summary: s
      description: d
      tags: [Corridors]
      x-smartremit-scope: corridors:read
      x-smartremit-sandbox: true
      responses: { '200': { description: OK } }
`;
    expect(() => parseOpenApi(dup)).toThrow(/operationId/);
  });

  it('loads the real openapi.yaml from the repo root', async () => {
    const { loadPartnerOpenApi } = await import('@/lib/openapi/load-spec');
    expect(loadPartnerOpenApi().length).toBeGreaterThan(0);
  });
});
