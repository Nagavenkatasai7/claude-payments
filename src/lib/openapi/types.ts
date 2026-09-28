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
}
