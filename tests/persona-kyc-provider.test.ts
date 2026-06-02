import { describe, it, expect, vi } from 'vitest';
import { PersonaKycProvider } from '@/lib/providers/persona-kyc-provider';
import type { PersonaClient } from '@/lib/providers/persona-client';

function fakeClient(over: Partial<PersonaClient> = {}): PersonaClient {
  return {
    createInquiry: vi.fn(async () => ({ inquiryId: 'inq_1', status: 'created' })),
    getInquiry: vi.fn(async () => ({ status: 'approved', raw: {} })),
    generateOneTimeLink: vi.fn(async () => 'https://withpersona.com/verify?code=abc'),
    ...over,
  } as unknown as PersonaClient;
}

describe('PersonaKycProvider', () => {
  it('startVerification creates an inquiry (reference-id = phone) + returns the hosted-flow link', async () => {
    const client = fakeClient();
    const p = new PersonaKycProvider(client, 'https://app');
    const r = await p.startVerification({ customerId: '15551230000', senderPhone: '15551230000' });
    expect(r.providerRef).toBe('inq_1');
    expect(r.url).toContain('withpersona.com/verify');
    expect(client.createInquiry).toHaveBeenCalledWith(expect.objectContaining({ referenceId: '15551230000' }));
    expect(client.generateOneTimeLink).toHaveBeenCalledWith('inq_1');
  });

  it('getStatus maps Persona inquiry status → KycStatus (Persona verdict, not the human gate)', async () => {
    expect(await new PersonaKycProvider(fakeClient({ getInquiry: vi.fn(async () => ({ status: 'approved', raw: {} })) }), 'x').getStatus('inq_1')).toBe('verified');
    expect(await new PersonaKycProvider(fakeClient({ getInquiry: vi.fn(async () => ({ status: 'declined', raw: {} })) }), 'x').getStatus('inq_1')).toBe('rejected');
    expect(await new PersonaKycProvider(fakeClient({ getInquiry: vi.fn(async () => ({ status: 'created', raw: {} })) }), 'x').getStatus('inq_1')).toBe('pending');
  });

  it('handleWebhook maps a parsed event to a KycWebhookResult', async () => {
    const p = new PersonaKycProvider(fakeClient(), 'x');
    const body = { data: { id: 'evt_1', attributes: { name: 'inquiry.approved', payload: { data: { id: 'inq_1', attributes: { status: 'approved' } } } } } };
    const r = await p.handleWebhook(body);
    expect(r).toMatchObject({ providerRef: 'inq_1', status: 'verified' });
  });

  it('handleWebhook returns null for an unparseable body', async () => {
    expect(await new PersonaKycProvider(fakeClient(), 'x').handleWebhook({ junk: 1 })).toBeNull();
  });
});
