import { describe, it, expect, vi } from 'vitest';
import { createPersonaClient } from '@/lib/providers/persona-client';

// Inline fixtures mirroring the Task-0 sandbox shapes (base, kebab keys, meta.one-time-link).
const INQUIRY_CREATED = { data: { id: 'inq_abc123', type: 'inquiry', attributes: { status: 'created', 'reference-id': '15551230000' } } };
const ONE_TIME_LINK = { meta: { 'one-time-link': 'https://withpersona.com/verify?code=ABC', 'one-time-link-short': 'https://perso.na/s/ABC' } };
const INQUIRY_GET = { data: { id: 'inq_abc123', attributes: { status: 'approved' } } };

function fakeFetch(json: unknown, status = 200) {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) }) as unknown as Response);
}

const baseOpts = { apiKey: 'persona_sandbox_x', apiVersion: '2025-12-08', base: 'https://api.withpersona.com/api/v1', templateVersionId: 'itmplv_x' };

describe('persona-client', () => {
  it('createInquiry POSTs the pinned template version + reference-id with the right headers', async () => {
    const fetchImpl = fakeFetch(INQUIRY_CREATED, 201);
    const client = createPersonaClient({ ...baseOpts, fetchImpl });
    const res = await client.createInquiry({ referenceId: '15551230000', idempotencyKey: 'k1' });
    expect(res.inquiryId).toBe('inq_abc123');
    expect(res.status).toBe('created');
    const [url, init] = (fetchImpl.mock.calls[0] as unknown as [string, any]);
    expect(url).toBe('https://api.withpersona.com/api/v1/inquiries');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer persona_sandbox_x');
    expect(init.headers['Persona-Version']).toBe('2025-12-08');
    expect(init.headers['Key-Inflection']).toBe('kebab');
    expect(init.headers['Idempotency-Key']).toBe('k1');
    const body = JSON.parse(init.body);
    expect(body.data.attributes['inquiry-template-version-id']).toBe('itmplv_x');
    expect(body.data.attributes['reference-id']).toBe('15551230000');
  });

  it('generateOneTimeLink returns meta.one-time-link', async () => {
    const client = createPersonaClient({ ...baseOpts, fetchImpl: fakeFetch(ONE_TIME_LINK) });
    expect(await client.generateOneTimeLink('inq_abc123')).toBe('https://withpersona.com/verify?code=ABC');
  });

  it('getInquiry returns the status', async () => {
    const client = createPersonaClient({ ...baseOpts, fetchImpl: fakeFetch(INQUIRY_GET) });
    expect((await client.getInquiry('inq_abc123')).status).toBe('approved');
  });

  it('throws on a non-2xx response', async () => {
    const client = createPersonaClient({ ...baseOpts, fetchImpl: fakeFetch({ errors: [{ title: 'bad' }] }, 401) });
    await expect(client.createInquiry({ referenceId: 'x', idempotencyKey: 'k' })).rejects.toThrow(/401/);
  });
});
