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
    const note = '[SEND CURRENCIES: USD, GBP — ask the user which currency they are sending, pass it as source_currency to get_quote/check_send_limit/send_approve_picker, and state the amount in that currency.]';
    expect(note.toLowerCase()).not.toContain('partner');
  });
});

describe('P5 corridor guards: bot never surfaces corridor/compliance config', () => {
  const filesToScan = ['src/lib/prompt.ts', 'src/lib/agent.ts', 'src/lib/tools.ts'];
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
  const filesToScan = ['src/lib/prompt.ts', 'src/lib/agent.ts', 'src/lib/tools.ts'];
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
