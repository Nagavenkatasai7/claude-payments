import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT } from '@/lib/prompt';

describe('SYSTEM_PROMPT', () => {
  it('names the tools the agent must use', () => {
    expect(SYSTEM_PROMPT).toContain('get_quote');
    expect(SYSTEM_PROMPT).toContain('send_approve_picker');
    expect(SYSTEM_PROMPT).toContain('check_payment_status');
  });

  it('describes the one-tap Approve & Pay flow (no separate link, cancel by text)', () => {
    expect(SYSTEM_PROMPT).toContain('Approve & Pay');
    // the bot must NOT call generate_payment_link in the happy path any more
    expect(SYSTEM_PROMPT).toContain('do NOT call generate_payment_link');
    // cancel is the typed word now (no Cancel button)
    expect(SYSTEM_PROMPT).toContain('cancel_draft');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('reply "cancel"');
  });

  it('forbids asking for card details in chat', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('card');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('never');
  });

  it('includes the conditional ENHANCED VERIFICATION block gated on edd_required', () => {
    expect(SYSTEM_PROMPT).toContain('ENHANCED VERIFICATION');
    expect(SYSTEM_PROMPT).toContain('edd_required');
    expect(SYSTEM_PROMPT).toContain('source_of_funds');
    expect(SYSTEM_PROMPT).toContain('occupation');
  });

  it('instructs the bot to ask NOTHING extra when edd_required is false (dormancy)', () => {
    expect(SYSTEM_PROMPT).toMatch(/edd_required is false/i);
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('never ask');
  });
});

describe('SYSTEM_PROMPT — typed-name resolution & shorthand (Bundle C)', () => {
  it('tells the bot to resolve a typed recipient name via resolve_recipient', () => {
    expect(SYSTEM_PROMPT).toContain('resolve_recipient');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('exact');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('ambiguous');
  });
  it('keeps check_send_limit before get_quote on the shorthand path', () => {
    // shorthand must not bypass the cap gate
    expect(SYSTEM_PROMPT).toContain('check_send_limit');
  });
});

describe('SYSTEM_PROMPT — sticky funding default (Bundle C)', () => {
  it('tells the bot to use the [SENDER DEFAULTS] funding method when present', () => {
    expect(SYSTEM_PROMPT).toContain('[SENDER DEFAULTS]');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('default');
  });
});

describe('SYSTEM_PROMPT — reactive repeat (Bundle C)', () => {
  it('tells the bot to use repeat_transfer reactively, never proactively', () => {
    expect(SYSTEM_PROMPT).toContain('repeat_transfer');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('do not offer this proactively');
  });
  it('handles the needs_edd follow-up', () => {
    expect(SYSTEM_PROMPT).toContain('needs_edd');
  });
});

describe('SYSTEM_PROMPT — get_quote cap refusal (Bundle D)', () => {
  it('tells the bot get_quote may itself return a cap refusal to handle like check_send_limit', () => {
    expect(SYSTEM_PROMPT).toContain('get_quote');
    // assert the actual Bundle-D note (not just the word within_cap, which the
    // check_send_limit section already contains) so this is a real regression guard
    expect(SYSTEM_PROMPT).toContain('get_quote ALSO guards the cap itself');
    expect(SYSTEM_PROMPT).toContain('do NOT show');
  });
});

describe('SYSTEM_PROMPT — non-supported destination lead capture', () => {
  it('references capture_corridor_request for unsupported destinations', () => {
    expect(SYSTEM_PROMPT).toContain('capture_corridor_request');
  });

  it('does not instruct the bot to refuse flatly for non-India destinations', () => {
    // The old flat-refusal text must be gone
    expect(SYSTEM_PROMPT).not.toContain('do NOT offer other destinations');
  });

  it('steers back to supported countries after capturing a lead for an unsupported destination', () => {
    // The old India-only steer-back is gone; now generic
    expect(SYSTEM_PROMPT.toLowerCase()).not.toContain('in the meantime i can send to india');
    // Instead it should steer back to supported countries in general
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('which of our current countries');
  });

  it('instructs the bot NOT to say "corridor" to the customer', () => {
    // The prompt must warn the bot that "corridor" is an internal term
    // that must not be spoken to the customer.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('do not say');
  });
});

describe('whatsapp-ux: any-to-any bank-to-bank flow', () => {
  it('a2a: does NOT ask credit/debit card and asks for the amount (no funding-method question)', () => {
    // The old combined "amount + funding method" question is gone
    expect(SYSTEM_PROMPT).not.toMatch(/how do you want to pay/i);
    // Funding question is gone — no "credit card, debit card, or bank transfer" choice
    expect(SYSTEM_PROMPT).not.toMatch(/credit card.*debit card.*bank transfer/i);
    // The first question is just the amount
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('how much would you like to send');
    // Bank transfer is always the method — it should say so
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('always bank transfer');
  });

  it('B2/B3: two-ask recipient + immediate validate_phone call', () => {
    expect(SYSTEM_PROMPT).toContain('validate_phone');
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/name and (their )?whatsapp number/);
  });

  it('A5: surfaces FX rate + ETA + payout destination in confirmations', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('delivery time');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('payout destination');
  });

  it('multi-country: currency is auto-detected, the bot does not ask by default', () => {
    expect(SYSTEM_PROMPT.toUpperCase()).toContain('AUTO-DETECTED');
    expect(SYSTEM_PROMPT).toContain('NOT need to ask which currency');
    expect(SYSTEM_PROMPT).toContain('source_currency');
  });

  it('a2a: supports all 8 countries (no India-only restriction)', () => {
    // The old "pays out only in India" restriction is gone
    expect(SYSTEM_PROMPT.toLowerCase()).not.toContain('pays out only in india');
    // All 8 countries are listed
    expect(SYSTEM_PROMPT).toContain('[SEND CURRENCIES');
    // The old blanket "sending money to India" promise is gone
    expect(SYSTEM_PROMPT).not.toContain('Do not promise anything beyond sending money to India');
    // Now sends between 8 countries in any direction
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('8 countries');
    expect(SYSTEM_PROMPT).toContain('bank-to-bank');
  });

  it('a2a: prompt references destination_country parameter', () => {
    expect(SYSTEM_PROMPT).toContain('destination_country');
  });

  it('a2a: prompt asks for destination country when not given', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('which country are you sending to');
  });

  it('a2a: prompt includes per-country bank-detail guidance', () => {
    // All major formats must appear
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('iban');           // AE
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('routing number'); // US
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('sort code');      // GB
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('ifsc');           // IN
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('bsb');            // AU
  });

  it('a2a: payout is always bank account, no UPI offered', () => {
    // UPI must not be offered as a payout option to customers
    expect(SYSTEM_PROMPT.toLowerCase()).not.toMatch(/how should they receive.*upi/i);
    // Payout is always bank
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("payout is always a bank account");
  });
});
