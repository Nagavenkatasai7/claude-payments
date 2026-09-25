import { describe, it, expect } from 'vitest';
import { aadFor } from '@/lib/field-crypto';
import {
  ctx,
  customerRowCtx,
  customerEmailCtx,
  conversationRowCtx,
  outboxSealedCtx,
  recipientRowCtx,
  sellerRowCtx,
} from '@/lib/crypto-context';

// Program-Fix 46A. These AAD strings are a STORAGE FORMAT: every v2 row is
// sealed under one of them. Changing any byte orphans every v2 row of that
// column — so each helper's exact output is pinned here.
describe('crypto-context pins the exact AAD strings', () => {
  const cases: [string, ReturnType<typeof ctx.transfer>, string][] = [
    ['transfer', ctx.transfer('tx_1', 'payout_destination_enc'), 'v2|k0|transfers|payout_destination_enc|tx_1'],
    ['transfer legal', ctx.transfer('tx_1', 'recipient_legal_name_enc'), 'v2|k0|transfers|recipient_legal_name_enc|tx_1'],
    ['transfer sender biz', ctx.transfer('tx_1', 'sender_business_name_enc'), 'v2|k0|transfers|sender_business_name_enc|tx_1'],
    ['transfer recipient biz', ctx.transfer('tx_1', 'recipient_business_name_enc'), 'v2|k0|transfers|recipient_business_name_enc|tx_1'],
    ['customer', ctx.customer('acme', '15550001111', 'full_name_enc'), 'v2|k0|customers|full_name_enc|acme|15550001111'],
    ['customer dob', ctx.customer('acme', '15550001111', 'date_of_birth_enc'), 'v2|k0|customers|date_of_birth_enc|acme|15550001111'],
    ['customer addr', ctx.customer('acme', '15550001111', 'residential_address_enc'), 'v2|k0|customers|residential_address_enc|acme|15550001111'],
    ['customer gov id', ctx.customer('acme', '15550001111', 'gov_id_number_enc'), 'v2|k0|customers|gov_id_number_enc|acme|15550001111'],
    ['customer email', ctx.customer('acme', '15550001111', 'email_enc'), 'v2|k0|customers|email_enc|acme|15550001111'],
    // Program-Fix 49D: the customer portal TOTP secret (NOT v1-exempt, unlike staff_mfa).
    ['customer mfa', ctx.customer('acme', '15550001111', 'mfa_totp_enc'), 'v2|k0|customers|mfa_totp_enc|acme|15550001111'],
    ['seller', ctx.seller('acme', '919800000000'), 'v2|k0|sellers|payout_destination_enc|acme|919800000000'],
    ['recipient', ctx.recipient('acme', '15550001111', '919800000000'), 'v2|k0|recipients|payout_destination_enc|acme|15550001111|919800000000'],
    ['beneficiary', ctx.beneficiary('ben_1'), 'v2|k0|beneficiaries|payout_destination_enc|ben_1'],
    ['schedule', ctx.schedule('sch_1'), 'v2|k0|schedules|payout_destination_enc|sch_1'],
    ['integration', ctx.integration('acme', 'wa_app_secret_enc'), 'v2|k0|partner_integrations|wa_app_secret_enc|acme'],
    ['integration creds', ctx.integration('acme', 'payment_credentials_enc'), 'v2|k0|partner_integrations|payment_credentials_enc|acme'],
    ['waitlist', ctx.waitlist('wl_1', 'email_enc'), 'v2|k0|waitlist_signups|email_enc|wl_1'],
    ['staff mfa', ctx.staffMfa('admin'), 'v2|k0|staff_mfa|secret|admin'],
    ['customer_ref', ctx.purpose('customer_ref'), 'v2|k0|purpose|customer_ref|'],
    ['apply_link', ctx.purpose('outbox.apply_link'), 'v2|k0|purpose|outbox.apply_link|'],
    // Partner-Demo R3b: the sealed conversation log. The row parts bind the
    // tenant, the row id, the thread (hex of the 32-byte thread_key), the
    // channel and the direction, so a body re-attributed to another thread,
    // channel or direction does not open.
    [
      'conversation message',
      ctx.conversationMessage('acme', '0b7c2f7e-1a2b-4c3d-8e9f-001122334455', 'ab'.repeat(32), 1, 2),
      `v2|k0|conversation_messages|body_enc|acme|0b7c2f7e-1a2b-4c3d-8e9f-001122334455|${'ab'.repeat(32)}|1|2`,
    ],
  ];
  it.each(cases)('%s', (_name, c, expected) => {
    expect(aadFor(c)).toBe(expected);
  });

  it('conversationRowCtx builds the same context from a fetched row (bytea as Buffer or Uint8Array)', () => {
    const id = '0b7c2f7e-1a2b-4c3d-8e9f-001122334455';
    const tk = Buffer.alloc(32, 0xab);
    const expected = aadFor(ctx.conversationMessage('acme', id, 'ab'.repeat(32), 2, 1));
    expect(aadFor(conversationRowCtx({ partnerId: 'acme', id, threadKey: tk, channel: 2, direction: 1 }))).toBe(expected);
    expect(
      aadFor(conversationRowCtx({ partnerId: 'acme', id, threadKey: new Uint8Array(tk), channel: 2, direction: 1 })),
    ).toBe(expected);
  });

  it('escapes a key part that contains the separator', () => {
    expect(aadFor(ctx.customer('a|b', '1 2', 'full_name_enc'))).toBe('v2|k0|customers|full_name_enc|a%7Cb|1%202');
  });
});

describe('crypto-context v1 exemptions (honoured by 46B)', () => {
  it('only staffMfa and customer_ref are permanently v1-exempt', () => {
    expect(ctx.staffMfa('admin').v1Exempt).toBe(true);
    expect(ctx.purpose('customer_ref').v1Exempt).toBe(true);
    expect(ctx.purpose('outbox.apply_link').v1Exempt).toBeFalsy();
    expect(ctx.transfer('t', 'payout_destination_enc').v1Exempt).toBeFalsy();
    expect(ctx.customer('p', '1', 'full_name_enc').v1Exempt).toBeFalsy();
    expect(customerRowCtx({ partnerId: 'p', phone: '1' }, 'mfa_totp_enc').v1Exempt).toBeFalsy();
  });
});

describe('row-shaped helpers (one per table, used by BOTH the write and the read side)', () => {
  it('customerRowCtx reads the row key columns', () => {
    expect(customerRowCtx({ partnerId: 'acme', phone: '1555' }, 'full_name_enc')).toEqual(
      ctx.customer('acme', '1555', 'full_name_enc'),
    );
  });

  it('customerEmailCtx defaults a missing partnerId exactly like customerToRow', () => {
    expect(customerEmailCtx({ senderPhone: '1555' })).toEqual(ctx.customer('default', '1555', 'email_enc'));
    expect(customerEmailCtx({ partnerId: 'acme', senderPhone: '1555' })).toEqual(
      ctx.customer('acme', '1555', 'email_enc'),
    );
  });

  it('recipientRowCtx / sellerRowCtx read the row key columns', () => {
    expect(recipientRowCtx({ partnerId: 'acme', senderPhone: '1', recipientPhone: '2' })).toEqual(
      ctx.recipient('acme', '1', '2'),
    );
    expect(sellerRowCtx({ partnerId: 'acme', phone: '9' })).toEqual(ctx.seller('acme', '9'));
  });

  it('outboxSealedCtx maps a placeholder key to its purpose (the one mapping)', () => {
    expect(outboxSealedCtx('apply_link')).toEqual(ctx.purpose('outbox.apply_link'));
  });

  it('builders never throw on odd key values (v1 hot path safety)', () => {
    expect(() => ctx.customer(undefined as unknown as string, '', 'full_name_enc')).not.toThrow();
    expect(() => customerRowCtx({} as { partnerId: string; phone: string }, 'full_name_enc')).not.toThrow();
  });
});
