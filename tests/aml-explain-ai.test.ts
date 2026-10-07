import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, Transfer } from '@/lib/types';
import { AML_DEFAULTS } from '@/lib/aml-rules';
import { AML_HOLD_REASON } from '@/lib/aml-hold';
import { LARGE_AMOUNT_REASON } from '@/lib/compliance-config';
import { SENDER_IDENTITY_MISSING_REASON } from '@/lib/compliance';

// A4 — the AML "Explain" copilot. Read-only, rung-1: it explains why a transfer
// raised an AML alert or sits on hold; it never decides. Under test:
//  1. the FACTS bundle (pure): only numbers and closed strings, never an id, a
//     name, a phone, a destination, KYC data or a note; the partner audience
//     (owner decision D5) drops count, sums, window and thresholds;
//  2. explainAml: ONE chat(messages, []) call, the next step clamped to the
//     closed list, empty output throws, the guardrails are in the prompt;
//  3. amlExplainFallback: deterministic per rule.

vi.mock('@/lib/ollama', () => ({ chat: vi.fn() }));

import { chat } from '@/lib/ollama';
import {
  AML_EXPLAIN_NEXT_STEPS,
  AML_EXPLAIN_SYSTEM_PROMPT,
  amlExplainFallback,
  amlExplainPrompt,
  buildAmlExplainBundle,
  explainAml,
  AML_EXPLAIN_TIMEOUT_MS,
} from '@/lib/aml-explain-ai';

const chatMock = vi.mocked(chat);
const NOW = Date.parse('2026-06-17T12:00:00.000Z');
const CFG = { ...AML_DEFAULTS, largeAmountUsd: 1000 };

// Fixture PII that must NEVER reach the model.
const PHONE = '15557771234';
const RECIPIENT = 'Priyanka Venkataraman';
const RECIPIENT_PHONE = '919812345678';
const TRANSFER_ID = 'tr_explain_fixture_42';
const PARTNER_ID = 'acme-remit';
const LAST4 = '9876';
const SENDER_BIZ = 'Globex Trading LLC';

function makeTransfer(over: Partial<Transfer> = {}): Transfer {
  return {
    id: TRANSFER_ID,
    phone: PHONE,
    amountUsd: 850,
    feeUsd: 1.99,
    totalChargeUsd: 851.99,
    fxRate: 85,
    amountInr: 72_250,
    recipientName: RECIPIENT,
    recipientPhone: RECIPIENT_PHONE,
    payoutMethod: 'bank',
    payoutDestination: `****${LAST4}`,
    fundingMethod: 'bank_transfer',
    complianceStatus: 'flagged',
    complianceReasons: [AML_HOLD_REASON],
    status: 'in_review',
    createdAt: new Date(NOW - 5 * 3_600_000).toISOString(),
    paidAt: new Date(NOW - 3 * 3_600_000).toISOString(),
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: PARTNER_ID,
    amountSource: 850,
    feeSource: 1.99,
    totalChargeSource: 851.99,
    recipientLegalName: RECIPIENT,
    senderBusinessName: SENDER_BIZ,
    ...over,
  };
}

const structuringAlert = { meta: { rule: 'structuring', window: '7d', count: 3, sumUsd: 2550 } };

function reply(content: string | null): ChatMessage {
  return { role: 'assistant', content };
}

beforeEach(() => chatMock.mockReset());

describe('buildAmlExplainBundle (pure)', () => {
  it('carries the structuring facts for platform staff (rule, reason, window, count, sum, thresholds)', () => {
    const b = buildAmlExplainBundle(makeTransfer(), [structuringAlert], CFG, 'platform', NOW);
    expect(b.rules).toEqual([
      {
        rule: 'structuring',
        reason: 'several smaller sends that add up to a large amount',
        source: 'alert',
        window: '7d',
        count: 3,
        sumUsd: 2550,
      },
    ]);
    expect(b.thresholds).toEqual({
      largeAmountUsd: 1000, bandLowerUsd: 800, structuringCount: 3, aggregateUsd: 3000, firstTransferUsd: 500, clusterSenders: 3,
    });
    expect(b).toMatchObject({
      audience: 'platform',
      amountUsd: 850,
      sourceCountry: 'US',
      destinationCountry: 'IN',
      payoutMethodClass: 'bank',
      transferType: 'b2c',
      holdAgeHours: 3,
      holdReasons: ['aml_hold'],
      eddRequired: false,
      onHold: true,
    });
  });

  it('the serialized prompt contains no phone, name, recipient, transfer id, partner id or last4', () => {
    const b = buildAmlExplainBundle(makeTransfer(), [structuringAlert], CFG, 'platform', NOW);
    const all = JSON.stringify(amlExplainPrompt(b));
    for (const secret of [PHONE, PHONE.slice(-4), RECIPIENT, 'Priyanka', RECIPIENT_PHONE, TRANSFER_ID, PARTNER_ID, LAST4, SENDER_BIZ, '****']) {
      expect(all).not.toContain(secret);
    }
  });

  it('the partner audience (D5) omits count, sumUsd, window and thresholds', () => {
    const b = buildAmlExplainBundle(makeTransfer(), [structuringAlert], CFG, 'partner', NOW);
    expect(b.rules).toEqual([
      { rule: 'structuring', reason: 'several smaller sends that add up to a large amount', source: 'alert' },
    ]);
    expect(b.thresholds).toBeUndefined();
    const all = JSON.stringify(amlExplainPrompt(b));
    expect(all).not.toContain('2550');
    expect(all).not.toMatch(/7d|window|threshold/i);
    expect(all).not.toMatch(/\bcount\b/i);
  });

  it('allow-lists hold reasons: known constants map to codes, anything else is "other" (never the text)', () => {
    const b = buildAmlExplainBundle(
      makeTransfer({
        complianceReasons: [LARGE_AMOUNT_REASON, SENDER_IDENTITY_MISSING_REASON, 'edd_required', 'Call Priyanka on 919812345678', 'Another free text'],
      }),
      [],
      CFG,
      'platform',
      NOW,
    );
    expect(b.holdReasons).toEqual(['large_amount', 'sender_identity_missing', 'edd_required', 'other']);
    expect(JSON.stringify(amlExplainPrompt(b))).not.toContain('Priyanka');
  });

  it('a held row with no aml.alert yet uses the caller-recomputed hit, marked "recomputed"', () => {
    const b = buildAmlExplainBundle(makeTransfer(), [], CFG, 'platform', NOW, {
      rule: 'first_transfer', window: 'first', count: 1, sumUsd: 850,
    });
    expect(b.rules).toEqual([
      { rule: 'first_transfer', reason: 'a large first send from a new customer', source: 'recomputed', window: 'first', count: 1, sumUsd: 850 },
    ]);
    // an alert row wins over a recomputed hit
    const withAlert = buildAmlExplainBundle(makeTransfer(), [structuringAlert], CFG, 'platform', NOW, {
      rule: 'first_transfer', window: 'first', count: 1, sumUsd: 850,
    });
    expect(withAlert.rules.map((r) => r.source)).toEqual(['alert']);
  });

  it('drops malformed alert rows (unknown rule, odd window, non-finite numbers) and dedupes rules', () => {
    const b = buildAmlExplainBundle(
      makeTransfer(),
      [
        { meta: { rule: 'bogus', window: '7d', count: 1, sumUsd: 1 } },
        { meta: { rule: 'cluster', window: 'forever', count: 'x', sumUsd: Infinity } },
        { meta: { rule: 'cluster', window: '30d', count: 4, sumUsd: 0 } },
      ],
      CFG,
      'platform',
      NOW,
    );
    expect(b.rules).toEqual([
      { rule: 'cluster', reason: 'many different senders paying one recipient', source: 'alert' },
    ]);
  });

  it('a row that is not on hold has no hold age; b2b and usdc are carried as closed classes', () => {
    const b = buildAmlExplainBundle(
      makeTransfer({ status: 'delivered', complianceStatus: 'cleared', complianceReasons: [], transferType: 'b2b', payoutMethod: 'usdc', eddRequired: true }),
      [structuringAlert],
      CFG,
      'platform',
      NOW,
    );
    expect(b).toMatchObject({ onHold: false, holdAgeHours: null, holdReasons: [], transferType: 'b2b', payoutMethodClass: 'usdc', eddRequired: true });
  });
});

describe('explainAml (one chat call, clamped)', () => {
  const bundle = () => buildAmlExplainBundle(makeTransfer(), [structuringAlert], CFG, 'platform', NOW);

  it('makes ONE chat call with tools [] and returns {summary, checks, next_step}', async () => {
    chatMock.mockResolvedValueOnce(reply(JSON.stringify({
      summary: 'Three sends just under the threshold within a week.',
      checks: ['Look at the sender history.', 'Compare with stated purpose.'],
      next_step: 'request_source_of_funds',
    })));
    const r = await explainAml(bundle());
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(chatMock.mock.calls[0][1]).toEqual([]);
    expect(chatMock.mock.calls[0][0][0]).toMatchObject({ role: 'system', content: AML_EXPLAIN_SYSTEM_PROMPT });
    expect(r).toEqual({
      summary: 'Three sends just under the threshold within a week.',
      checks: ['Look at the sender history.', 'Compare with stated purpose.'],
      next_step: 'request_source_of_funds',
    });
  });

  // Prod 2026-10-07 17:04Z: the explain call hit the agent's 20 s budget and fell back.
  // A staff click is not the worker's row deadline, so it gets the longer copilot budget.
  it('calls the model with the copilot timeout, not the 20 s agent budget', async () => {
    chatMock.mockResolvedValueOnce(reply('{"summary":"ok","checks":[],"next_step":"escalate"}'));
    await explainAml(bundle());
    expect(chatMock.mock.calls[0][2]).toEqual({ timeoutMs: AML_EXPLAIN_TIMEOUT_MS });
    expect(AML_EXPLAIN_TIMEOUT_MS).toBeGreaterThan(20_000);
    expect(AML_EXPLAIN_TIMEOUT_MS).toBeLessThanOrEqual(50_000);
  });

  it('the messages sent to the model carry no PII', async () => {
    chatMock.mockResolvedValueOnce(reply('{"summary":"ok","checks":[],"next_step":"escalate"}'));
    await explainAml(bundle());
    const sent = JSON.stringify(chatMock.mock.calls[0][0]);
    for (const secret of [PHONE, RECIPIENT, RECIPIENT_PHONE, TRANSFER_ID, PARTNER_ID, LAST4, SENDER_BIZ]) {
      expect(sent).not.toContain(secret);
    }
  });

  it('clamps next_step to the closed list (off-list, "release" or missing ⇒ review_sender_history)', async () => {
    for (const next of ['release', 'approve', 42, undefined]) {
      chatMock.mockResolvedValueOnce(reply(JSON.stringify({ summary: 's', checks: [], next_step: next })));
      expect((await explainAml(bundle())).next_step).toBe('review_sender_history');
    }
    expect(AML_EXPLAIN_NEXT_STEPS).not.toContain('release');
    expect([...AML_EXPLAIN_NEXT_STEPS]).toEqual([
      'review_sender_history', 'request_source_of_funds', 'verify_recipient_relationship', 'escalate', 'keep_on_hold', 'close_alert_no_action',
    ]);
  });

  it('caps checks at 5 strings and drops non-strings / blanks', async () => {
    chatMock.mockResolvedValueOnce(reply(JSON.stringify({
      summary: 's', checks: ['a', 7, '', ' b ', 'c', 'd', 'e', 'f'], next_step: 'keep_on_hold',
    })));
    expect((await explainAml(bundle())).checks).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('survives a chatty reply around the JSON object', async () => {
    chatMock.mockResolvedValueOnce(reply('Sure! {"summary":"x {y}","checks":["c"],"next_step":"escalate"} Hope that helps.'));
    expect(await explainAml(bundle())).toEqual({ summary: 'x {y}', checks: ['c'], next_step: 'escalate' });
  });

  it('throws on empty output (null content, no JSON, blank summary)', async () => {
    for (const c of [null, 'no json here', '{"summary":"  ","checks":[]}']) {
      chatMock.mockResolvedValueOnce(reply(c));
      await expect(explainAml(bundle())).rejects.toThrow();
    }
  });

  it('the system prompt carries the staff guardrails', () => {
    expect(AML_EXPLAIN_SYSTEM_PROMPT).toContain('Never approve, release, reject or decide');
    expect(AML_EXPLAIN_SYSTEM_PROMPT).toContain('legal conclusion');
    expect(AML_EXPLAIN_SYSTEM_PROMPT).toContain('tipping off');
    expect(AML_EXPLAIN_SYSTEM_PROMPT).toContain('Use only the facts given');
  });
});

describe('amlExplainFallback (deterministic)', () => {
  it('is deterministic and rule-specific', () => {
    const s = buildAmlExplainBundle(makeTransfer(), [structuringAlert], CFG, 'platform', NOW);
    expect(amlExplainFallback(s)).toEqual(amlExplainFallback(s));
    expect(amlExplainFallback(s).next_step).toBe('review_sender_history');
    expect(amlExplainFallback(s).summary).toContain('several smaller sends that add up to a large amount');
    expect(amlExplainFallback(s).checks.length).toBeGreaterThan(0);
    expect(amlExplainFallback(s).checks.length).toBeLessThanOrEqual(5);

    const ft = buildAmlExplainBundle(makeTransfer(), [{ meta: { rule: 'first_transfer', window: 'first', count: 1, sumUsd: 850 } }], CFG, 'platform', NOW);
    expect(amlExplainFallback(ft).next_step).toBe('request_source_of_funds');
    const nb = buildAmlExplainBundle(makeTransfer(), [{ meta: { rule: 'new_beneficiary', window: 'destination', count: 2, sumUsd: 850 } }], CFG, 'platform', NOW);
    expect(amlExplainFallback(nb).next_step).toBe('verify_recipient_relationship');
    const cl = buildAmlExplainBundle(makeTransfer(), [{ meta: { rule: 'cluster', window: '30d', count: 4, sumUsd: 0 } }], CFG, 'platform', NOW);
    expect(amlExplainFallback(cl).next_step).toBe('escalate');
    const none = buildAmlExplainBundle(makeTransfer(), [], CFG, 'platform', NOW);
    expect(amlExplainFallback(none).next_step).toBe('keep_on_hold');
  });

  it('platform text may quote the numbers; partner text never does', () => {
    const p = amlExplainFallback(buildAmlExplainBundle(makeTransfer(), [structuringAlert], CFG, 'platform', NOW));
    expect(p.summary).toContain('3');
    expect(p.summary).toContain('2,550');
    const q = amlExplainFallback(buildAmlExplainBundle(makeTransfer(), [structuringAlert], CFG, 'partner', NOW));
    expect(JSON.stringify(q)).not.toContain('2,550');
    expect(JSON.stringify(q)).not.toContain('7 days');
  });

  it('never names a person, phone or id', () => {
    const f = JSON.stringify(amlExplainFallback(buildAmlExplainBundle(makeTransfer(), [structuringAlert], CFG, 'platform', NOW)));
    for (const secret of [PHONE, RECIPIENT, TRANSFER_ID, PARTNER_ID, LAST4]) expect(f).not.toContain(secret);
  });
});
