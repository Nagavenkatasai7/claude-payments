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

// M4 PR-4: the API reference page renders the document around the operations too (server,
// tags, component schemas) and each response's body (schema $ref / example / content types).
const DOC = `
openapi: 3.1.0
info: { title: Partner API, version: '1', description: The description. }
servers: [{ url: https://smartremit.ai/api/partner/v1 }]
tags:
  - { name: Transactions, description: Mint and read. }
  - { name: Settlements, description: Statement. }
components:
  schemas:
    Error:
      type: object
      required: [error]
      properties:
        error: { type: string, description: Human-readable. }
    Txn:
      type: object
      properties:
        id: { type: string }
        sender_name: { type: [string, 'null'] }
        created_at: { type: string, format: date-time }
  responses:
    Unauthorized:
      description: Missing key.
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Error' }
paths:
  /transactions/{id}:
    get:
      operationId: getTransaction
      summary: Fetch
      tags: [Transactions]
      x-smartremit-scope: transactions:read
      x-smartremit-sandbox: true
      responses:
        '200':
          description: The transaction.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Txn' }
        '401': { $ref: '#/components/responses/Unauthorized', description: Missing or invalid key. }
        '404': { description: Not found. }
  /settlements:
    get:
      operationId: listSettlements
      summary: Statement
      tags: [Settlements]
      x-smartremit-scope: settlements:read
      x-smartremit-sandbox: false
      requestBody:
        required: true
        content:
          application/json:
            example: { a: 1 }
      responses:
        '200':
          description: A page.
          content:
            application/json:
              example: { settlements: [] }
            text/csv: {}
`;

describe('parseOpenApiDocument', () => {
  it('returns the server URL, the tag list in order, and the info text', async () => {
    const { parseOpenApiDocument } = await import('@/lib/openapi/load-spec');
    const doc = parseOpenApiDocument(DOC);
    expect(doc.title).toBe('Partner API');
    expect(doc.description).toBe('The description.');
    expect(doc.serverUrl).toBe('https://smartremit.ai/api/partner/v1');
    expect(doc.tags).toEqual([
      { name: 'Transactions', description: 'Mint and read.' },
      { name: 'Settlements', description: 'Statement.' },
    ]);
    expect(doc.operations.map((o) => o.operationId)).toEqual(['getTransaction', 'listSettlements']);
  });

  it('parses component schemas: array types print as a union, format and required are kept', async () => {
    const { parseOpenApiDocument } = await import('@/lib/openapi/load-spec');
    const { schemas } = parseOpenApiDocument(DOC);
    expect(schemas.map((s) => s.name)).toEqual(['Error', 'Txn']);
    expect(schemas[0].fields).toEqual([{ name: 'error', type: 'string', format: null, required: true, description: 'Human-readable.' }]);
    expect(schemas[1].fields).toEqual([
      { name: 'id', type: 'string', format: null, required: false, description: '' },
      { name: 'sender_name', type: 'string | null', format: null, required: false, description: '' },
      { name: 'created_at', type: 'string', format: 'date-time', required: false, description: '' },
    ]);
  });

  it('resolves response bodies: a schema $ref by name, a $ref response through components, examples and content types', async () => {
    const { parseOpenApiDocument } = await import('@/lib/openapi/load-spec');
    const [get, settle] = parseOpenApiDocument(DOC).operations;
    expect(get.responseBodies[200]).toEqual({ schema: 'Txn', example: null, contentTypes: ['application/json'] });
    // A $ref response: its sibling description wins, the body comes from the referenced response.
    expect(get.responses[401]).toBe('Missing or invalid key.');
    expect(get.responseBodies[401]).toEqual({ schema: 'Error', example: null, contentTypes: ['application/json'] });
    expect(get.responseBodies[404]).toEqual({ schema: null, example: null, contentTypes: [] });
    expect(settle.responseBodies[200]).toEqual({ schema: null, example: { settlements: [] }, contentTypes: ['application/json', 'text/csv'] });
    expect(settle.requestBodyRequired).toBe(true);
    expect(get.requestBodyRequired).toBe(false);
  });

  it('throws on a $ref it cannot resolve (fail loud, never a silently empty body)', async () => {
    const { parseOpenApiDocument } = await import('@/lib/openapi/load-spec');
    expect(() => parseOpenApiDocument(DOC.replace("'#/components/responses/Unauthorized'", "'#/components/responses/Nope'"))).toThrow(/Nope/);
    expect(() => parseOpenApiDocument(DOC.replace("'#/components/schemas/Txn'", "'#/components/schemas/Nope'"))).toThrow(/Nope/);
  });

  it('parseOpenApi is the operations of the document', async () => {
    const { parseOpenApi, parseOpenApiDocument } = await import('@/lib/openapi/load-spec');
    expect(parseOpenApi(DOC)).toEqual(parseOpenApiDocument(DOC).operations);
  });

  it('loads the real document: 6 tags, the Transaction and Error schemas, 11 operations', async () => {
    const { loadPartnerOpenApiDocument } = await import('@/lib/openapi/load-spec');
    const doc = loadPartnerOpenApiDocument();
    expect(doc.tags.map((t) => t.name)).toEqual(['Corridors', 'Quotes', 'Beneficiaries', 'Transactions', 'Rates', 'Settlements']);
    expect(doc.schemas.map((s) => s.name)).toEqual(['Error', 'Transaction']);
    expect(doc.operations).toHaveLength(11);
    const confirm = doc.operations.find((o) => o.operationId === 'confirmTransaction')!;
    expect(confirm.responseBodies[200].schema).toBe('Transaction');
    expect(confirm.responseBodies[429].schema).toBe('Error');
  });
});

describe('response objects fail loud on keys they do not understand', () => {
  it('throws on an unknown response key (an unquoted comma in a YAML flow map splits the description)', async () => {
    const { parseOpenApiDocument } = await import('@/lib/openapi/load-spec');
    expect(() => parseOpenApiDocument(DOC.replace("'404': { description: Not found. }", "'404': { description: Not found, or gone. }"))).toThrow(
      /GET \/transactions\/\{id\} response 404 has unknown key "or gone\."/,
    );
  });
  it('the real openapi.yaml keeps every description whole', async () => {
    const { loadPartnerOpenApiDocument } = await import('@/lib/openapi/load-spec');
    const ops = loadPartnerOpenApiDocument().operations;
    const confirm = ops.find((o) => o.operationId === 'confirmTransaction')!;
    expect(confirm.responses[403]).toBe('The key lacks transactions:write, or the partner is not active.');
    expect(confirm.responses[409]).toBe('The transaction is not awaiting payment (for example, it was cancelled).');
  });
});
