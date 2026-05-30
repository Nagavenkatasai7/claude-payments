import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Hard rule (P2): no string assigned to a chat-message `content` field
// anywhere in the bot code path may contain the word "partner".
// This guards against accidentally surfacing tenant-internal terminology
// to end-customers via the WhatsApp bot.
describe('P2 hard rule: bot never mentions partner in any chat content', () => {
  const filesToScan = [
    'src/lib/prompt.ts',
    'src/lib/agent.ts',
    'src/lib/tools.ts',
    'src/lib/recent-transfers.ts',
    'tests/agent.test.ts',
    'tests/e2e.test.ts',
  ];

  for (const rel of filesToScan) {
    it(`${rel} has no chat content containing "partner"`, () => {
      const full = resolve(process.cwd(), rel);
      const contents = readFileSync(full, 'utf-8');
      // Find every `content: '...'` literal in the file. We iterate via
      // matchAll which yields every regex match at once.
      const pattern = /content:\s*['"`]([^'"`]*?)['"`]/g;
      const matches = [...contents.matchAll(pattern)];
      for (const m of matches) {
        const text = m[1];
        expect(text.toLowerCase()).not.toContain('partner');
      }
    });
  }
});

describe('P4 currency note guards', () => {
  it('P4: injected currency note never contains the word "partner"', () => {
    const note = '[SEND CURRENCIES: USD, GBP. The sender sends in USD (auto-detected from their number) — do NOT ask which currency; the tools default to it. Pass source_currency ONLY if the sender explicitly asks for a different listed currency.]';
    expect(note.toLowerCase()).not.toContain('partner');
  });
});

describe('P5 corridor guards: bot never surfaces corridor/compliance config', () => {
  const filesToScan = ['src/lib/prompt.ts', 'src/lib/agent.ts', 'src/lib/tools.ts', 'src/lib/recent-transfers.ts'];
  const forbidden = ['corridor', 'watchlist', 'corridorcompliance', 'sanctions'];

  for (const rel of filesToScan) {
    it(`${rel} has no chat content mentioning corridor/compliance internals`, () => {
      const contents = readFileSync(resolve(process.cwd(), rel), 'utf-8');
      const matches = [...contents.matchAll(/content:\s*['"`]([^'"`]*?)['"`]/g)];
      for (const m of matches) {
        const text = m[1].toLowerCase();
        for (const term of forbidden) expect(text).not.toContain(term);
      }
    });
  }

  it('P5: a corridor watchlistExtra name never appears verbatim in bot content', () => {
    // The mock corridor name used in tests must not be hard-coded into any prompt/tool string.
    const sample = 'corridor villain';
    for (const rel of ['src/lib/prompt.ts', 'src/lib/agent.ts', 'src/lib/tools.ts']) {
      const contents = readFileSync(resolve(process.cwd(), rel), 'utf-8').toLowerCase();
      expect(contents).not.toContain(sample);
    }
  });
});

describe('KYC guards: bot never leaks PII values or EDD internals to chat content', () => {
  const filesToScan = ['src/lib/prompt.ts', 'src/lib/agent.ts', 'src/lib/tools.ts', 'src/lib/recent-transfers.ts'];
  // Stored-PII / internal terms that must never appear inside a chat content literal.
  const forbidden = ['govidnumber', 'gov_id', 'residentialaddress', 'pepdeclared', 'eddcapturedat'];

  for (const rel of filesToScan) {
    it(`${rel} has no chat content leaking a PII value or EDD internal`, () => {
      const contents = readFileSync(resolve(process.cwd(), rel), 'utf-8');
      const matches = [...contents.matchAll(/content:\s*['"`]([^'"`]*?)['"`]/g)];
      for (const m of matches) {
        const text = m[1].toLowerCase();
        for (const term of forbidden) expect(text).not.toContain(term);
      }
    });
  }

  it('the prompt mentions source of funds / occupation only as a question, not a stored field name', () => {
    const prompt = readFileSync(resolve(process.cwd(), 'src/lib/prompt.ts'), 'utf-8');
    // The instruction must be present (Task 10) but must not echo a stored value back.
    expect(prompt).toContain('source of funds');
    expect(prompt.toLowerCase()).not.toContain('your source of funds is');
  });
});

describe('transfer-memory: recent-transfers module + rendered note stay partner-/compliance-blind', () => {
  it('the module source contains none of the forbidden tenant/compliance terms', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/recent-transfers.ts'), 'utf-8').toLowerCase();
    for (const term of ['partner', 'corridor', 'watchlist', 'sanctions', 'compliance'])
      expect(src).not.toContain(term);
    // 'blocked' MUST appear once — as the STATUS_LABEL KEY mapping to 'on hold' —
    // but never as a value the customer sees. Assert the mapping is to 'on hold'.
    expect(src).toContain("blocked: 'on hold'");
  });

  it('a rendered note (incl. a blocked transfer) leaks no tenant/compliance internals', async () => {
    const { createStore } = await import('@/lib/store');
    const { fakeRedis } = await import('./helpers');
    const { getRecentTransfersNote } = await import('@/lib/recent-transfers');
    const store = createStore(fakeRedis());
    const base = {
      id: 'g1', phone: '+1555', amountUsd: 500, feeUsd: 5, totalChargeUsd: 505, fxRate: 83,
      amountInr: 41500, recipientName: 'Mom', recipientPhone: '919', payoutMethod: 'upi',
      payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer', complianceStatus: 'cleared',
      complianceReasons: [], status: 'delivered', createdAt: '2026-05-28T12:00:00Z',
      partnerId: 'default', sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
      destinationCurrency: 'INR', amountSource: 500, feeSource: 5, totalChargeSource: 505,
    };
    await store.saveTransfer(base as never);
    await store.saveTransfer({ ...base, id: 'g2', recipientName: 'Ravi', status: 'blocked',
      createdAt: '2026-05-27T12:00:00Z' } as never);

    const note = (await getRecentTransfersNote('+1555', store)).toLowerCase();
    for (const term of ['partner', 'corridor', 'watchlist', 'sanctions', 'blocked', 'compliance', 'partnerid'])
      expect(note).not.toContain(term);
    expect(note).toContain('mom');     // customer-owned data IS present
    expect(note).toContain('on hold'); // blocked surfaced as the soft label
  });
});

describe('Bundle C: [SENDER DEFAULTS] note + new tool modules stay partner-/compliance-/PII-blind', () => {
  it('the rendered sender-defaults note leaks no internal term', async () => {
    const { getSenderDefaultsNote } = await import('@/lib/sender-defaults');
    const note = getSenderDefaultsNote({
      senderPhone: '15551234567',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'default',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastFundingMethod: 'bank_transfer',
      lastFundingMethodAt: new Date().toISOString(),
    }).toLowerCase();
    for (const term of ['partner', 'corridor', 'compliance', 'watchlist', 'sanctions', 'provider', 'govid', 'residentialaddress'])
      expect(note).not.toContain(term);
  });

  it('sender-defaults.ts source contains no forbidden internal term', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/sender-defaults.ts'), 'utf-8').toLowerCase();
    for (const term of ['partner', 'corridor', 'watchlist', 'sanctions'])
      expect(src).not.toContain(term);
  });
});
