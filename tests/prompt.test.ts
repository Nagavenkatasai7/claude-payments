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

describe('SYSTEM_PROMPT — non-India destination lead capture', () => {
  it('references capture_corridor_request for non-India destinations', () => {
    expect(SYSTEM_PROMPT).toContain('capture_corridor_request');
  });

  it('does not instruct the bot to refuse flatly for non-India destinations', () => {
    // The old flat-refusal text must be gone
    expect(SYSTEM_PROMPT).not.toContain('do NOT offer other destinations');
  });

  it('steers back to India after capturing the lead', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('in the meantime i can send to india');
  });

  it('instructs the bot NOT to say "corridor" to the customer', () => {
    // The prompt must warn the bot that "corridor" is an internal term
    // that must not be spoken to the customer.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('do not say');
  });
});

describe('whatsapp-ux: faster first send + clearer confirmation + destination reword', () => {
  it('B1: asks amount + funding method together in one turn', () => {
    expect(SYSTEM_PROMPT).toMatch(/how do you want to pay/i);
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('together'); // the combined-ask instruction
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
  it('A5: distinguishes pay-out from send-from (no blanket send-block)', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('pays out only in india');
    expect(SYSTEM_PROMPT).toContain('[SEND CURRENCIES');
    // the old blanket "sending money to India" send-blocking promise is gone
    expect(SYSTEM_PROMPT).not.toContain('Do not promise anything beyond sending money to India');
  });
});
