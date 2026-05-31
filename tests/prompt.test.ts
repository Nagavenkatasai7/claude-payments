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

describe('SYSTEM_PROMPT — QA hardening (Fix #1 #2 #3 #4 #5 #6)', () => {
  it('Fix #1: never-echo-full-account rule is present', () => {
    expect(SYSTEM_PROMPT.toUpperCase()).toContain('NEVER REPEAT A CUSTOMER');
    expect(SYSTEM_PROMPT).toContain('****6789');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('approval card already masks it');
    // QA batch 3: last-4-only in chat free-text — no routing/IFSC/sort/IBAN echo
    expect(SYSTEM_PROMPT).toContain('LAST-4 ONLY in chat');
    expect(SYSTEM_PROMPT).toContain('IFSC HDFC0005678');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('never echo the routing number');
  });

  it('Fix #2: over_daily_cap message does NOT volunteer the amount already spent', () => {
    // Old wording "(already sent $Z today)" must be gone
    expect(SYSTEM_PROMPT).not.toContain('already sent $Z today');
    // New wording uses today_remaining_usd
    expect(SYSTEM_PROMPT).toContain('today_remaining_usd');
    expect(SYSTEM_PROMPT).toContain('do NOT volunteer the exact amount already spent');
  });

  it('Fix #3: send-amount lock rule is present', () => {
    expect(SYSTEM_PROMPT).toContain('amount_usd to every later get_quote call');
    expect(SYSTEM_PROMPT).toContain('confirm with the user first');
    // Must not silently switch to receive-first
    expect(SYSTEM_PROMPT).toContain('must NOT silently change the send amount');
    // QA batch 3: hardened lock — explicit confirm BEFORE any re-quote
    expect(SYSTEM_PROMPT).toContain('SEND AMOUNT LOCK');
    expect(SYSTEM_PROMPT).toContain('that send amount is LOCKED');
    expect(SYSTEM_PROMPT).toContain('You MUST NOT call get_quote with amount_inr');
    expect(SYSTEM_PROMPT).toContain('Re-quoting and then showing the new numbers is NEVER itself the confirmation');
  });

  it('Fix #4: unsupported-country section leads with limitation, not with an affirmative opener', () => {
    // The first instruction in the list says to lead with the limitation
    expect(SYSTEM_PROMPT).toContain("Lead with the limitation");
    // Country list appears in the example message
    expect(SYSTEM_PROMPT).toContain("We don't deliver to <country> yet");
    // The 8 countries are named in the unsupported-destination example
    expect(SYSTEM_PROMPT).toContain('US, Canada, UK, UAE, Singapore, Australia, New Zealand, and India');
    // The bot must NOT start with an affirmative opener that implies the country is supported
    expect(SYSTEM_PROMPT).toContain('Do NOT start with "That sounds great!"');
    // QA batch 3: hardened into a mandatory ordered sequence with explicit forbidden openers
    expect(SYSTEM_PROMPT).toContain('ORDERED SEQUENCE');
    expect(SYSTEM_PROMPT).toContain('FORBIDDEN OPENERS');
    expect(SYSTEM_PROMPT).toContain('Roughly how much');
  });

  it('Fix #5: payee-name echo rule is present', () => {
    expect(SYSTEM_PROMPT).toContain('Got it — sending to Bobby');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('catch a wrong name');
  });

  it('Fix #6: phone-country vs destination mismatch warning is present', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('country code matches the destination country');
    expect(SYSTEM_PROMPT).toContain('+91');
    // Must not block, just confirm
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("don't block it, just confirm");
  });
});

describe('SYSTEM_PROMPT — QA batch 2 (multi-currency cap labels, opener, blocks)', () => {
  it('caps are always stated in USD, never re-labeled with the send-currency symbol', () => {
    expect(SYSTEM_PROMPT).toContain('CAPS ARE ALWAYS IN US DOLLARS');
    expect(SYSTEM_PROMPT).toContain('NEVER convert a cap into the send currency');
  });

  it('unsupported-destination opener ban: never lead with "Got it"/"noted your interest"', () => {
    expect(SYSTEM_PROMPT).toContain('Do NOT open with "Got it"');
    expect(SYSTEM_PROMPT).toContain('VERY FIRST sentence must say we don\'t deliver there yet');
  });

  it('compliance blocks are relayed verbatim, never framed as a technical error', () => {
    expect(SYSTEM_PROMPT).toContain('COMPLIANCE BLOCKS');
    expect(SYSTEM_PROMPT).toContain('reply_to_customer');
    expect(SYSTEM_PROMPT).toContain('something went wrong on our end');
  });
});

describe('SYSTEM_PROMPT — anti-upsell / no-fabricated-minimum rule', () => {
  it('states the minimum is $10 INCLUSIVE and the max is $2,999', () => {
    expect(SYSTEM_PROMPT).toContain('$10 INCLUSIVE');
    expect(SYSTEM_PROMPT).toContain('$2,999');
  });

  it('forbids inventing a minimum-amount error or calling $10+ too low', () => {
    expect(SYSTEM_PROMPT).toContain('NEVER invent a minimum-amount error');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('too low');
  });

  it('forbids upselling — never suggest or ask for a HIGHER amount than requested', () => {
    expect(SYSTEM_PROMPT).toContain('NEVER suggest or ask for a HIGHER amount than the user requested');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('no upselling');
  });

  it('only refuses when a tool actually returns a refusal, relaying that exact reason', () => {
    expect(SYSTEM_PROMPT).toContain('ACTUALLY returns a refusal');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('never a fabricated minimum');
  });
});

describe('SYSTEM_PROMPT — recurring schedule guardrails (QA #7)', () => {
  it('tells the bot schedules run until cancelled or until an optional end date', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('until they cancel');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('optional end date');
  });

  it('tells the bot each run uses the daily sending cap that day', () => {
    expect(SYSTEM_PROMPT.toUpperCase()).toContain('EACH RUN USES THEIR DAILY SENDING CAP');
  });

  it('tells the bot to offer an end date and confirm schedule details including end date', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('offer to set an end date');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('confirm the schedule details including the end date');
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

  it('A5: surfaces FX rate + ETA in confirmations', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('delivery time');
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('exchange rate');
  });

  // Item 2: bank details are NEVER collected in chat — the sender enters them on
  // the secure pay page. The prompt says so and no longer carries a per-country
  // "BANK DETAILS BY COUNTRY" block.
  it('Item 2: bank details are entered on the secure pay page, not in chat', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('secure pay page');
    expect(SYSTEM_PROMPT).not.toContain('BANK DETAILS BY COUNTRY');
    expect(SYSTEM_PROMPT.toLowerCase()).not.toContain('ask 2 — bank details');
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

  it('Item 2: country bank codes appear ONLY as "never echo these" guidance, not a collect list', () => {
    // The bank-format codes still appear — but only in the LAST-4 / never-echo
    // rule, NOT as an "ask the user for these fields" block. The old
    // "BANK DETAILS BY COUNTRY" collect block is gone (asserted above).
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('iban');           // AE
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('routing number'); // US
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('sort code');      // GB
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('ifsc');           // IN
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('bsb');            // AU
  });

  it('Item 2: never asks for bank/account details in chat', () => {
    // UPI must not be offered as a payout option to customers
    expect(SYSTEM_PROMPT.toLowerCase()).not.toMatch(/how should they receive.*upi/i);
    // The recipient's bank details are entered on the secure pay page, never in chat.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('never ask for card details or bank account details in chat');
  });
});
