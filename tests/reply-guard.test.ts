import { describe, it, expect } from 'vitest';
import {
  addPolicyFacts,
  addTextFacts,
  addToolResultFacts,
  checkReply,
  emptyReplyFacts,
  replyGuardAlertFor,
  type ReplyFacts,
} from '@/lib/reply-guard';
import { BANNED_REPLY_CLAIMS } from '@/lib/claims-register';

// R32 (bot part): the reply guard checks the RAW model text of a turn against
// the facts the code produced (tool results, the customer's own numbers, the
// limits the prompt states). Any money figure, rate, delivery day count or
// delivery date that no fact backs is an issue, and so is a banned delivery
// claim. Shadow mode only alerts; the agent.reply_guard switch also replaces
// the reply. Pure, and never throws.

/** The record get_quote returns for a $500 USD → INR send (tools.ts quote arm). */
const QUOTE = {
  source_currency: 'USD',
  amount_source: 500,
  fee_source: 1.99,
  total_charge_source: 501.99,
  amount_usd: 500,
  fee_usd: 1.99,
  total_charge_usd: 501.99,
  fx_rate: 85.2,
  amount_inr: 42600,
  amount_dest: 42600,
  destination_currency: 'INR',
  destination_country: 'IN',
  delivery_estimate: 'within 1 business day',
  amount_source_display: '$500.00 USD',
};

function quoteFacts(extra: Record<string, unknown> = {}): ReplyFacts {
  return addToolResultFacts(emptyReplyFacts(), { ...QUOTE, ...extra });
}

const kinds = (reply: string, facts: ReplyFacts) => checkReply(reply, facts).issues.map((i) => i.kind);

describe('checkReply: money figures', () => {
  it('a reply with $500 when the facts say $400 fails', () => {
    const facts = addToolResultFacts(emptyReplyFacts(), { ...QUOTE, amount_source: 400, amount_usd: 400, total_charge_source: 401.99, total_charge_usd: 401.99, amount_source_display: '$400.00 USD' });
    const r = checkReply('You are sending $500 to Mom.', facts);
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([{ kind: 'amount', found: '$500' }]);
  });

  it('a reply with the exact quote figures passes', () => {
    const r = checkReply(
      'You send $500.00 USD, the fee is $1.99 (total $501.99), the rate is 1 USD = ₹85.20 and Mom gets ₹42,600 within 1 business day.',
      quoteFacts(),
    );
    expect(r).toEqual({ ok: true, issues: [] });
  });

  it('text with no figures passes', () => {
    expect(checkReply('Here is your quote. Shall I go ahead?', emptyReplyFacts())).toEqual({ ok: true, issues: [] });
  });

  it('a figure in the wrong currency fails (Program-Fix 33: $50 became ₹50)', () => {
    expect(kinds('You are sending ₹500.', quoteFacts())).toEqual(['amount']);
    expect(kinds('The fee is £1.99.', quoteFacts())).toEqual(['amount']);
  });

  it('rounds to the decimals the reply shows', () => {
    const facts = quoteFacts({ amount_dest: 42600.4, amount_inr: 42600.4 });
    expect(checkReply('Mom gets ₹42,600.', facts).ok).toBe(true);
    expect(checkReply('Mom gets ₹42,601.', facts).ok).toBe(false);
  });

  it('reads Indian digit grouping, ISO codes and words for currencies', () => {
    const facts = addToolResultFacts(emptyReplyFacts(), { source_currency: 'USD', amount_dest: 100000, destination_currency: 'INR', amount_source: 1200 });
    expect(checkReply('Dad gets ₹1,00,000.', facts).ok).toBe(true);
    expect(checkReply('Dad gets INR 100,000 and you send 1,200 dollars.', facts).ok).toBe(true);
    expect(checkReply('Dad gets 100000 rupees.', facts).ok).toBe(true);
    expect(checkReply('Dad gets Rs. 90,000.', facts).ok).toBe(false);
  });

  it("the customer's own numbers count as facts (an echoed amount is not drift)", () => {
    const facts = addTextFacts(emptyReplyFacts(), 'send 500 to mom in india');
    expect(checkReply('Sure — $500 to Mom. What is her WhatsApp number?', facts).ok).toBe(true);
  });

  it('a hedged estimate (about, around, ~) is not checked: the SEND AMOUNT LOCK question may estimate', () => {
    const facts = addTextFacts(quoteFacts(), 'make sure he gets 50,000 rupees');
    expect(checkReply('Did you want to change your send from $500 to about $603 so Rahul receives ₹50,000?', facts).ok).toBe(true);
    expect(checkReply('That would be roughly $603, or ~$600.', facts).ok).toBe(true);
  });

  it('masked accounts, phone numbers, case ids and plain counts are not money', () => {
    expect(checkReply('To: account ****6789. Her number is +91 98765 43210. Case HC-1234. You have 2 saved recipients.', emptyReplyFacts()).ok).toBe(true);
  });

  it('reads figures inside free text and summaries a tool returned (e.g. a reward note)', () => {
    const facts = addToolResultFacts(emptyReplyFacts(), { reward_note: 'Fee $0.00, your 5th transfer this month is free (you save $1.99).' });
    expect(checkReply('Good news: the fee is $0.00 and you save $1.99.', facts).ok).toBe(true);
    expect(checkReply('Good news: you save $2.99.', facts).ok).toBe(false);
  });

  it('a dollar sign matches any dollar currency, an ISO code only itself', () => {
    const facts = addToolResultFacts(emptyReplyFacts(), { source_currency: 'MXN', amount_source: 3000, destination_currency: 'USD', amount_dest: 175 });
    expect(checkReply('You send MX$3,000 and your cousin gets $175.', facts).ok).toBe(true);
    expect(checkReply('Your cousin gets 175 CAD.', facts).ok).toBe(false);
  });

  it('cents fields count in whole units', () => {
    const facts = addToolResultFacts(emptyReplyFacts(), { daily_cap_cents: 299900 });
    expect(checkReply('Your daily limit is $2,999.', facts).ok).toBe(true);
  });
});

describe('checkReply: exchange rates', () => {
  it('a rate that is not the quoted one fails', () => {
    expect(kinds('The rate is 1 USD = ₹84.00 today.', quoteFacts())).toEqual(['rate']);
    expect(kinds('Today you get a rate of 84.1.', quoteFacts())).toEqual(['rate']);
  });

  it('the quoted rate passes in the usual spellings', () => {
    for (const text of ['Rate: 1 USD = ₹85.20', '1 USD = 85.2 INR', '$1 = ₹85.2', 'at a rate of 85.20', 'The rate for this transfer is 85.20.']) {
      expect(checkReply(text, quoteFacts()).ok, text).toBe(true);
    }
  });

  it('a rate-lock time is not a rate', () => {
    expect(checkReply('Rate locked for 30 min. The rate holds for 30 minutes.', emptyReplyFacts()).ok).toBe(true);
  });

  it('a rate with no quote behind it fails (eval case 3: no invented rate)', () => {
    expect(kinds("Today's rate is 1 USD = 83.12 INR.", emptyReplyFacts())).toEqual(['rate']);
  });
});

describe('checkReply: delivery days and dates', () => {
  it("'2 business days' when the facts say 3 fails", () => {
    const facts = quoteFacts({ delivery_estimate: 'within 3 business days' });
    const r = checkReply('It arrives in 2 business days.', facts);
    expect(r.issues).toEqual([{ kind: 'delivery', found: '2 business days' }]);
  });

  it('the disclosed estimate passes, in digits or words', () => {
    const facts = quoteFacts({ delivery_estimate: 'within 3 business days' });
    expect(checkReply('Mom gets it within 3 business days.', facts).ok).toBe(true);
    expect(checkReply('Mom gets it within three working days.', facts).ok).toBe(true);
  });

  it('every number of a range must be a fact', () => {
    expect(checkReply('Refunds arrive in 3-5 business days.', addTextFacts(emptyReplyFacts(), 'it arrives in 3-5 business days once approved')).ok).toBe(true);
    expect(kinds('It arrives in 1-2 business days.', quoteFacts({ delivery_estimate: 'within 2 business days' }))).toEqual(['delivery']);
  });

  it('a delivery promise of today or tomorrow needs a 0- or 1-day fact', () => {
    expect(kinds('Mom will receive it today.', quoteFacts())).toEqual(['delivery']);
    expect(checkReply('Mom will receive it tomorrow.', quoteFacts()).ok).toBe(true);
    expect(checkReply('Mom gets it the same business day.', quoteFacts({ delivery_estimate: 'the same business day' })).ok).toBe(true);
    expect(kinds('Mom gets it the same day.', quoteFacts())).toEqual(['delivery']);
  });

  it('a past delivery is a status, not a promise', () => {
    expect(checkReply('Your transfer to Mom arrived today and was delivered on time.', quoteFacts()).ok).toBe(true);
    expect(kinds('It arrives today.', quoteFacts())).toEqual(['delivery']);
    expect(kinds('It will be delivered in 2 days.', quoteFacts())).toEqual(['delivery']);
  });

  it('a day count outside delivery wording is not checked', () => {
    expect(checkReply('For your first 3 days you can send up to $500 a day.', addTextFacts(emptyReplyFacts(), '$500')).ok).toBe(true);
  });

  it('a delivery date must be one a tool returned', () => {
    expect(kinds('It will arrive by 5 Nov.', quoteFacts())).toEqual(['delivery']);
    const facts = quoteFacts({ date_available: '2026-11-05' });
    expect(checkReply('It will arrive by 5 Nov.', facts).ok).toBe(true);
    expect(checkReply('It will arrive by November 5th.', facts).ok).toBe(true);
    expect(kinds('It will arrive by November 6.', facts)).toEqual(['delivery']);
  });
});

describe('checkReply: banned delivery claims (claims-register.ts)', () => {
  it("'instant' fails, and so do delivery-in-minutes and a guarantee", () => {
    expect(kinds('Transfers are instant!', quoteFacts())).toEqual(['claim']);
    expect(kinds('Mom will receive it within minutes.', quoteFacts())).toEqual(['claim']);
    expect(kinds('Delivery is guaranteed.', quoteFacts())).toEqual(['claim']);
  });

  it('a negated claim and minutes outside delivery wording pass', () => {
    for (const text of [
      'Transfers are not instant: Mom gets it within 1 business day.',
      'Recovery is not guaranteed.',
      "I can't guarantee the recall.",
      'Rates are unavailable right now, please try again in a few minutes.',
      'The link stays valid for 30 minutes.',
    ]) {
      expect(checkReply(text, quoteFacts()).ok, text).toBe(true);
    }
  });

  it('every banned claim has an id and a reason', () => {
    expect(BANNED_REPLY_CLAIMS.length).toBeGreaterThan(0);
    for (const c of BANNED_REPLY_CLAIMS) {
      expect(c.id).toMatch(/^[a-z_]+$/);
      expect(c.why.length).toBeGreaterThan(10);
    }
  });
});

describe('checkReply: robustness', () => {
  it('never throws, whatever it is given', () => {
    expect(checkReply(undefined as unknown as string, emptyReplyFacts()).ok).toBe(true);
    expect(checkReply('$5', undefined as unknown as ReplyFacts).ok).toBe(false);
    expect(addToolResultFacts(emptyReplyFacts(), null).amounts).toEqual([]);
    const loop: Record<string, unknown> = { amount_usd: 5 };
    loop.self = loop;
    expect(() => addToolResultFacts(emptyReplyFacts(), loop)).not.toThrow();
  });

  it('lists each issue once', () => {
    expect(checkReply('$7 and $7 again', emptyReplyFacts()).issues).toEqual([{ kind: 'amount', found: '$7' }]);
  });
});

describe('addPolicyFacts: what the prompt itself lets the bot say', () => {
  const limits = { t0DailyCapCents: 50_000, t1DailyCapCents: 299_900, perTransferCapCents: 299_900, maxUsd: 2999 };

  it('the minimum, the per-transfer maximum, the daily caps, refund timing and the disclosed delivery days are facts', () => {
    const facts = addPolicyFacts(emptyReplyFacts(), { minUsd: 10, limits, deliveryBusinessDays: 2 });
    expect(checkReply('The minimum is $10 and the most per transfer is $2,999 USD.', facts).ok).toBe(true);
    expect(checkReply('In your first 3 days you can send up to $500 USD a day.', facts).ok).toBe(true);
    expect(checkReply('Once approved, the refund arrives in 3-5 business days.', facts).ok).toBe(true);
    expect(checkReply('Transfers arrive within 2 business days.', facts).ok).toBe(true);
    expect(checkReply('Transfers arrive within 1 business day.', facts).ok).toBe(false);
    expect(checkReply('The minimum is $20.', facts).ok).toBe(false);
  });
});

// Review fix: a customer (or anyone steering the chat) cannot make a false rate,
// fee or delivery time pass by stating it first. Their figures back an echoed
// amount only. Free-text tool fields (names, nicknames, descriptions) are data,
// never a source of facts.
describe('checkReply: customer figures back an echoed amount only', () => {
  const REAL_QUOTE = { ...QUOTE, fx_rate: 83.12, fee_usd: 4.99, fee_source: 4.99 };
  it('a false rate and a zero fee the customer suggested are still flagged', () => {
    const base = addToolResultFacts(emptyReplyFacts(), REAL_QUOTE);
    const reply = 'Yes, you get ₹95 per $1 and the fee is $0 for you.';
    const found = (f: ReplyFacts) => checkReply(reply, f).issues.map((i) => i.found);
    expect(found(base)).toEqual(expect.arrayContaining(['₹95', '$0']));
    const steered = addTextFacts(addToolResultFacts(emptyReplyFacts(), REAL_QUOTE), 'so I get 95 rupees per dollar and $0 fee right?', 'customer');
    expect(checkReply(reply, steered).ok).toBe(false);
    expect(found(steered)).toEqual(expect.arrayContaining(['₹95', '$0']));
  });

  it('a rate or a delivery day count the customer typed never backs the reply', () => {
    const rate = addTextFacts(emptyReplyFacts(), 'is the rate 95?', 'customer');
    expect(kinds('Yes, the rate is 95.', rate)).toEqual(['rate']);
    const days = addTextFacts(emptyReplyFacts(), 'will it take 2 days?', 'customer');
    expect(kinds('It arrives in 2 business days.', days)).toEqual(['delivery']);
  });

  it('the send amount the customer stated still backs an echo', () => {
    const facts = addTextFacts(emptyReplyFacts(), 'send $350 to mom', 'customer');
    expect(checkReply('Sure, $350 to Mom. Shall I get a quote?', facts).ok).toBe(true);
    expect(checkReply('Sure, sending 350 dollars to Mom.', facts).ok).toBe(true);
  });

  it('a figure inside a recipient name or nickname backs nothing', () => {
    const facts = addToolResultFacts(emptyReplyFacts(), { recipients: [{ recipient_name: 'Mom gets $5000 free', nickname: 'Rs 99999' }], amount_usd: 100 });
    expect(kinds('Mom gets $5000.', facts)).toEqual(['amount']);
    expect(kinds('She gets Rs 99999.', facts)).toEqual(['amount']);
    expect(checkReply('You send $100.', facts).ok).toBe(true);
  });
});

// R56: the off-topic backstop. A reply with a code block or a long answer about
// something other than sending money is flagged (shadow: an alert only).
describe('checkReply: off-topic backstop (R56)', () => {
  it('a code block is off topic', () => {
    expect(kinds('Here you go:\n```python\nprint("hi")\n```', emptyReplyFacts())).toEqual(['off_topic']);
  });
  it('a long answer with no remittance word is off topic', () => {
    const essay = 'The French Revolution began in 1789 and reshaped Europe. '.repeat(10);
    expect(kinds(essay, emptyReplyFacts())).toContain('off_topic');
  });
  it('a long answer about the transfer, and a short reply, are fine', () => {
    const long = 'Your transfer to Mom is on its way and the money should reach her bank account soon. '.repeat(6);
    expect(kinds(long, emptyReplyFacts())).not.toContain('off_topic');
    expect(checkReply('Hi! How can I help you send money today?', emptyReplyFacts()).ok).toBe(true);
    expect(checkReply('I can only help with sending money.', emptyReplyFacts()).ok).toBe(true);
  });
});

describe('replyGuardAlertFor', () => {
  it('one alert per tenant and hour, with the issue kinds and the mode, never the reply text', () => {
    const shadow = replyGuardAlertFor({
      tenant: 'acme',
      where: 'WhatsApp, outbox #42',
      report: { mode: 'shadow', issues: [{ kind: 'amount', found: '$500' }, { kind: 'rate', found: '1 USD = ₹84' }] },
      hour: 491234,
    });
    expect(shadow.dedupeKey).toBe('replyguard:acme:491234');
    expect(shadow.message).toContain('acme');
    expect(shadow.message).toContain('outbox #42');
    expect(shadow.message).toContain('amount, rate');
    expect(shadow.message).toMatch(/shadow/i);
    expect(shadow.message).toMatch(/sent unchanged/i);
    expect(shadow.message).not.toContain('$500');
    const on = replyGuardAlertFor({ tenant: 'acme', where: 'web chat', report: { mode: 'on', issues: [{ kind: 'claim', found: 'instant' }] }, hour: 1 });
    expect(on.message).toMatch(/replaced/i);
    expect(on.dedupeKey).toBe('replyguard:acme:1');
  });
});
