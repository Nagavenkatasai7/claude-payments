/**
 * persona-client — low-level Persona REST wrapper (Phase 2, Task 3).
 *
 * Shapes confirmed against the live sandbox 2026-06-02 (Task 0 spike):
 *  - base `https://api.withpersona.com/api/v1`
 *  - headers `Persona-Version: 2025-12-08`, `Key-Inflection: kebab`, `Idempotency-Key`
 *  - create body `{ data: { attributes: { 'inquiry-template-version-id', 'reference-id' } } }`
 *  - one-time link at `meta.one-time-link`
 *
 * `fetchImpl` is injectable so tests never touch the network.
 */

export interface PersonaClientOptions {
  apiKey: string;
  apiVersion: string;
  base: string;
  templateVersionId: string;
  fetchImpl?: typeof fetch;
}

export interface CreateInquiryInput {
  referenceId: string;
  idempotencyKey: string;
}
export interface CreateInquiryResult {
  inquiryId: string;
  status: string;
}

export function createPersonaClient(opts: PersonaClientOptions) {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    Authorization: `Bearer ${opts.apiKey}`,
    'Persona-Version': opts.apiVersion,
    'Key-Inflection': 'kebab',
    'Content-Type': 'application/json',
    ...extra,
  });

  return {
    async createInquiry(input: CreateInquiryInput): Promise<CreateInquiryResult> {
      const r = await doFetch(`${opts.base}/inquiries`, {
        method: 'POST',
        headers: headers({ 'Idempotency-Key': input.idempotencyKey }),
        body: JSON.stringify({
          data: {
            attributes: {
              'inquiry-template-version-id': opts.templateVersionId,
              'reference-id': input.referenceId,
            },
          },
        }),
      });
      if (!r.ok) throw new Error(`Persona createInquiry ${r.status}`);
      const j = (await r.json()) as { data?: { id?: string; attributes?: { status?: string } } };
      const inquiryId = j?.data?.id;
      if (!inquiryId) throw new Error('Persona createInquiry: missing data.id');
      return { inquiryId, status: j?.data?.attributes?.status ?? 'created' };
    },

    async getInquiry(inquiryId: string): Promise<{ status: string; raw: unknown }> {
      const r = await doFetch(`${opts.base}/inquiries/${inquiryId}`, { headers: headers() });
      if (!r.ok) throw new Error(`Persona getInquiry ${r.status}`);
      const j = (await r.json()) as { data?: { attributes?: { status?: string } } };
      return { status: j?.data?.attributes?.status ?? 'unknown', raw: j };
    },

    async generateOneTimeLink(inquiryId: string): Promise<string> {
      const r = await doFetch(`${opts.base}/inquiries/${inquiryId}/generate-one-time-link`, {
        method: 'POST',
        headers: headers(),
      });
      if (!r.ok) throw new Error(`Persona generateOneTimeLink ${r.status}`);
      const j = (await r.json()) as { meta?: Record<string, string>; data?: { attributes?: Record<string, string> } };
      const link = j?.meta?.['one-time-link'] ?? j?.data?.attributes?.['one-time-link'];
      if (!link) throw new Error('Persona generateOneTimeLink: missing meta.one-time-link');
      return link;
    },
  };
}

export type PersonaClient = ReturnType<typeof createPersonaClient>;
