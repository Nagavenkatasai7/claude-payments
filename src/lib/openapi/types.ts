// Shared types for the Partner API OpenAPI source of truth (openapi.yaml) and
// the static route inventory the drift test compares it with.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** One operation as the ROUTE FILES implement it (route-inventory.ts). */
export interface RouteOperation {
  /** OpenAPI-style path relative to /api/partner/v1, e.g. '/transactions/{id}/confirm'. */
  path: string;
  method: HttpMethod;
  /** The literal scope passed to guardPartner(req, '<scope>'). */
  scope: string;
  /** Every HTTP status the operation can return (guard ∪ service ∪ direct), sorted ascending. */
  statuses: number[];
}

/** One operation as openapi.yaml documents it (load-spec.ts). */
export interface SpecOperation {
  path: string;
  method: HttpMethod;
  operationId: string;
  summary: string;
  description: string;
  tag: string;
  /** x-smartremit-scope */
  scope: string;
  /** x-smartremit-sandbox: a sr_test_ key may call it. */
  sandbox: boolean;
  /** Keys of `responses`, numeric, sorted ascending. */
  statuses: number[];
  /** status → description */
  responses: Record<number, string>;
  parameters: Array<{ name: string; in: 'path' | 'query' | 'header'; required: boolean; description: string }>;
  /** requestBody.content['application/json'].example */
  requestExample: unknown | null;
  /** requestBody.required */
  requestBodyRequired: boolean;
  /** status → the response body as documented (a `$ref` response resolved through components). */
  responseBodies: Record<number, SpecResponseBody>;
}

/** One response body: the named component schema, the JSON example, and every content type. */
export interface SpecResponseBody {
  /** The components.schemas name of application/json's schema $ref, or null. */
  schema: string | null;
  /** application/json's example, or null. */
  example: unknown | null;
  /** The keys of `content`, in document order (empty when the response has no body). */
  contentTypes: string[];
}

/** One field of a component schema. `type` prints an array type as a union ('string | null'). */
export interface SpecSchemaField {
  name: string;
  type: string;
  format: string | null;
  required: boolean;
  description: string;
}

export interface SpecSchema {
  name: string;
  fields: SpecSchemaField[];
}

/** The whole openapi.yaml as the API reference renders it. */
export interface SpecDocument {
  title: string;
  description: string;
  /** servers[0].url */
  serverUrl: string;
  /** The top-level `tags`, in document order. */
  tags: Array<{ name: string; description: string }>;
  /** components.schemas, in document order. */
  schemas: SpecSchema[];
  operations: SpecOperation[];
}
