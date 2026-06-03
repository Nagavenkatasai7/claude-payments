import { describe, it, expect, vi } from 'vitest';
import {
  looksLikeVerifyHandoff,
  reusableInquiryId,
  issueVerifyLink,
} from '@/lib/verify-link';
import { createCustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { fakeRedis } from './helpers';
import type { Customer } from '@/lib/types';
import type { KycProvider, KycStartResult } from '@/lib/providers/kyc-provider';

const PHONE = '15550007777';

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    senderPhone: PHONE,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    kycStatus: 'not_started',
    senderCountry: 'US',
    partnerId: 'default',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Customer;
}

describe('looksLikeVerifyHandoff', () => {
  it('true when the model pasted any URL (it intends to share a link)', () => {
    expect(looksLikeVerifyHandoff('Here you go 👉 https://made-up.example/x')).toBe(true);
    expect(looksLikeVerifyHandoff('visit http://foo.test now')).toBe(true);
  });
  it('true when the text talks about verification / identity / kyc', () => {
    expect(looksLikeVerifyHandoff('Let me get you verified — one sec.')).toBe(true);
    expect(looksLikeVerifyHandoff('We need to confirm your identity first.')).toBe(true);
    expect(looksLikeVerifyHandoff('Your KYC is pending.')).toBe(true);
  });
  it('false for an ordinary reply with no link and no verify language', () => {
    expect(looksLikeVerifyHandoff('Hi there! How much would you like to send?')).toBe(false);
    expect(looksLikeVerifyHandoff('')).toBe(false);
  });
});

describe('reusableInquiryId', () => {
  it('returns the inquiry id when one exists and the customer is not rejected/terminal', () => {
    expect(reusableInquiryId(customer({ kycInquiryId: 'inq_1', kycReviewState: 'inquiry_started' }))).toBe('inq_1');
    expect(reusableInquiryId(customer({ kycInquiryId: 'inq_2', kycReviewState: 'pending_review' }))).toBe('inq_2');
    expect(reusableInquiryId(customer({ kycInquiryId: 'inq_3' }))).toBe('inq_3'); // no review state yet
  });
  it('returns undefined with no inquiry id, when hard-rejected, or at a terminal review state', () => {
    expect(reusableInquiryId(customer())).toBeUndefined();
    expect(reusableInquiryId(null)).toBeUndefined();
    expect(reusableInquiryId(customer({ kycInquiryId: 'inq_4', kycStatus: 'rejected' }))).toBeUndefined();
    expect(reusableInquiryId(customer({ kycInquiryId: 'inq_5', kycReviewState: 'rejected' }))).toBeUndefined();
    expect(reusableInquiryId(customer({ kycInquiryId: 'inq_6', kycReviewState: 'approved' }))).toBeUndefined();
  });
});

describe('issueVerifyLink', () => {
  it('mints a fresh inquiry and PERSISTS its id when the customer has none', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    await customerStore.saveCustomer(customer());
    const provider = new MockKycProvider(customerStore, 'https://example.com');

    const url = await issueVerifyLink({
      phone: PHONE,
      customer: customer(),
      kycProvider: provider,
      customerStore,
    });

    expect(url).toBe(`https://example.com/admin-dashboard/customers/${PHONE}`);
    const after = await customerStore.getCustomer(PHONE);
    expect(after?.kycInquiryId).toBe(`mock-${PHONE}`); // persisted for the next resend
  });

  it('REUSES an existing inquiry (no new mint) and does not re-persist', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const cust = customer({ kycInquiryId: 'inq_existing', kycReviewState: 'inquiry_started' });
    await customerStore.saveCustomer(cust);

    const seen: (string | undefined)[] = [];
    const provider: KycProvider = {
      async startVerification(input): Promise<KycStartResult> {
        seen.push(input.existingInquiryId);
        return { url: 'https://persona.example/reused', providerRef: input.existingInquiryId ?? 'inq_new' };
      },
      async getStatus() { return 'pending'; },
      async handleWebhook() { return null; },
    };
    const spy = vi.spyOn(customerStore, 'recordKycInquiry');

    const url = await issueVerifyLink({ phone: PHONE, customer: cust, kycProvider: provider, customerStore });

    expect(url).toBe('https://persona.example/reused');
    expect(seen).toEqual(['inq_existing']); // reuse path passed the existing id
    expect(spy).not.toHaveBeenCalled();     // nothing newly minted → nothing to persist
  });

  it('falls back to a fresh inquiry when reuse throws', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const cust = customer({ kycInquiryId: 'inq_stale', kycReviewState: 'inquiry_started' });
    await customerStore.saveCustomer(cust);

    const calls: (string | undefined)[] = [];
    const provider: KycProvider = {
      async startVerification(input): Promise<KycStartResult> {
        calls.push(input.existingInquiryId);
        if (input.existingInquiryId) throw new Error('Persona generateOneTimeLink 410'); // stale inquiry
        return { url: 'https://persona.example/fresh', providerRef: 'inq_fresh' };
      },
      async getStatus() { return 'pending'; },
      async handleWebhook() { return null; },
    };

    const url = await issueVerifyLink({ phone: PHONE, customer: cust, kycProvider: provider, customerStore });

    expect(url).toBe('https://persona.example/fresh');
    expect(calls).toEqual(['inq_stale', undefined]); // tried reuse, then minted fresh
    const after = await customerStore.getCustomer(PHONE);
    expect(after?.kycInquiryId).toBe('inq_fresh'); // fresh id persisted
  });

  it('returns null (never throws) when the provider fails on every attempt', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    await customerStore.saveCustomer(customer());
    const provider: KycProvider = {
      async startVerification(): Promise<KycStartResult> { throw new Error('Persona createInquiry 503'); },
      async getStatus() { return 'pending'; },
      async handleWebhook() { return null; },
    };

    const url = await issueVerifyLink({ phone: PHONE, customer: customer(), kycProvider: provider, customerStore });
    expect(url).toBeNull();
  });
});
