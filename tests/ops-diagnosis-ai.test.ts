import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatMessage } from '@/lib/types';

// U5 — the operations-diagnosis copilot AI module. Same two concerns as the
// ticket copilot (tests/ticket-ai.test.ts):
//  1. PROMPT-CONTENT GUARD: the system prompt must carry the forbidden-content
//     rules — no promises/guarantees, no refund commitments, no compliance
//     detail, no financial advice, no invented facts.
//  2. BEHAVIOR with chat() stubbed: the structured fields clamp to the closed
//     lists; the call is ONE-SHOT with NO tools; an empty model reply throws
//     (callers degrade to "AI unavailable"); the deterministic errorPrefix
//     helper normalizes for sibling clustering.

vi.mock('@/lib/ollama', () => ({ chat: vi.fn() }));

import { chat } from '@/lib/ollama';
import {
  diagnoseOps,
  errorPrefix,
  OPS_FAILURE_CLASSES,
  OPS_SUGGESTED_ACTIONS,
  OPS_BLAST_RADII,
  type OpsDiagnosisBundle,
} from '@/lib/ops-diagnosis-ai';

const chatMock = vi.mocked(chat);

function reply(content: string | null): ChatMessage {
  return { role: 'assistant', content };
}

const deadBundle: OpsDiagnosisBundle = {
  subjectKind: 'dead_letter',
  deadLetter: {
    id: 42,
    kind: 'settlement.instruct',
    attempts: 8,
    lastError: 'fetch failed: ECONNREFUSED https://partner.example/rail',
    providerType: 'http',
    ageMinutes: 30,
    siblingDeadCount: 3,
  },
};

const stuckBundle: OpsDiagnosisBundle = {
  subjectKind: 'stuck_transfer',
  transfer: {
    id: 'txn_1',
    status: 'paid',
    partnerId: 'default',
    amount: '$100.00',
    paidAgeMinutes: 45,
    providerType: 'simulator',
  },
};

beforeEach(() => {
  chatMock.mockReset();
});

describe('prompt-content guard: the system prompt forbids the dangerous content', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/ops-diagnosis-ai.ts'), 'utf-8');

  it('forbids promises and guarantees', () => {
    expect(src).toMatch(/never make promises or guarantees/i);
    expect(src).toMatch(/no delivery promises/i);
  });

  it('forbids refund commitments — "our team reviews refunds" is the only framing', () => {
    expect(src).toMatch(/never commit to a refund/i);
    expect(src).toMatch(/our team reviews refunds/i);
  });

  it('forbids compliance/screening/sanctions detail', () => {
    expect(src).toMatch(/never reveal compliance, screening, sanctions/i);
  });

  it('forbids financial advice', () => {
    expect(src).toMatch(/never give financial advice/i);
  });

  it('forbids inventing transaction facts', () => {
    expect(src).toMatch(/never invent transaction facts/i);
  });

  it('the diagnose system prompt interpolates the shared guardrails block', () => {
    const refs = src.match(/\$\{GUARDRAILS\}/g) ?? [];
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(src).toContain('DIAGNOSE_SYSTEM');
  });

  it('the system message passed to chat() carries the rules — and NO tools, ever', async () => {
    chatMock.mockResolvedValue(reply('{"failure_class":"unknown","suggested_action":"investigate","blast_radius":"isolated","rationale":"ok"}'));
    await diagnoseOps(deadBundle);
    await diagnoseOps(stuckBundle);
    for (const call of chatMock.mock.calls) {
      const system = call[0][0];
      expect(system.role).toBe('system');
      expect(system.content).toMatch(/never make promises or guarantees/i);
      expect(system.content).toMatch(/our team reviews refunds/i);
      // one-shot contract: NO tools, ever
      expect(call[1]).toEqual([]);
    }
  });
});

describe('diagnoseOps — structured fields clamped to the closed lists', () => {
  it('returns valid clamped fields verbatim with the rationale prose', async () => {
    chatMock.mockResolvedValue(
      reply('{"failure_class":"partner_5xx","suggested_action":"contact_partner","blast_radius":"cluster","rationale":"The partner rail returned 502 repeatedly."}'),
    );
    expect(await diagnoseOps(deadBundle)).toEqual({
      failure_class: 'partner_5xx',
      suggested_action: 'contact_partner',
      blast_radius: 'cluster',
      rationale: 'The partner rail returned 502 repeatedly.',
    });
  });

  it('every allowed enum value round-trips', async () => {
    for (const fc of OPS_FAILURE_CLASSES) {
      chatMock.mockResolvedValue(reply(`{"failure_class":"${fc}","suggested_action":"retry","blast_radius":"isolated","rationale":"r"}`));
      expect((await diagnoseOps(deadBundle)).failure_class).toBe(fc);
    }
    for (const sa of OPS_SUGGESTED_ACTIONS) {
      chatMock.mockResolvedValue(reply(`{"failure_class":"unknown","suggested_action":"${sa}","blast_radius":"isolated","rationale":"r"}`));
      expect((await diagnoseOps(deadBundle)).suggested_action).toBe(sa);
    }
    for (const br of OPS_BLAST_RADII) {
      chatMock.mockResolvedValue(reply(`{"failure_class":"unknown","suggested_action":"retry","blast_radius":"${br}","rationale":"r"}`));
      expect((await diagnoseOps(deadBundle)).blast_radius).toBe(br);
    }
  });

  it('off-list values collapse to the safe defaults (unknown / investigate / isolated)', async () => {
    chatMock.mockResolvedValue(
      reply('{"failure_class":"meltdown","suggested_action":"nuke_it","blast_radius":"galactic","rationale":"hmm"}'),
    );
    expect(await diagnoseOps(deadBundle)).toEqual({
      failure_class: 'unknown',
      suggested_action: 'investigate',
      blast_radius: 'isolated',
      rationale: 'hmm',
    });
  });

  it('prose-wrapped JSON still parses', async () => {
    chatMock.mockResolvedValue(
      reply('Here is my read: {"failure_class":"bad_settlement_url","suggested_action":"reconfigure_provider","blast_radius":"isolated","rationale":"Bad URL."} hope it helps'),
    );
    const d = await diagnoseOps(deadBundle);
    expect(d.failure_class).toBe('bad_settlement_url');
    expect(d.suggested_action).toBe('reconfigure_provider');
  });

  it('non-JSON prose falls back to defaults but keeps the prose as the rationale', async () => {
    chatMock.mockResolvedValue(reply('I think the partner endpoint is down — chase them.'));
    const d = await diagnoseOps(deadBundle);
    expect(d.failure_class).toBe('unknown');
    expect(d.suggested_action).toBe('investigate');
    expect(d.blast_radius).toBe('isolated');
    expect(d.rationale).toBe('I think the partner endpoint is down — chase them.');
  });

  it('throws on an empty model reply (caller degrades to "AI unavailable")', async () => {
    chatMock.mockResolvedValue(reply('   '));
    await expect(diagnoseOps(deadBundle)).rejects.toThrow(/empty/i);
    chatMock.mockResolvedValue(reply(null));
    await expect(diagnoseOps(stuckBundle)).rejects.toThrow(/empty/i);
    // Valid JSON shape but a blank rationale is still "empty" — the rationale is the payload.
    chatMock.mockResolvedValue(reply('{"failure_class":"unknown","suggested_action":"retry","blast_radius":"isolated","rationale":"   "}'));
    await expect(diagnoseOps(deadBundle)).rejects.toThrow(/empty/i);
  });
});

describe('diagnoseOps — bundle facts reach the model (masked, deterministic)', () => {
  it('the dead-letter prompt carries the kind, error, provider type, and sibling count', async () => {
    chatMock.mockResolvedValue(reply('{"failure_class":"partner_5xx","suggested_action":"contact_partner","blast_radius":"cluster","rationale":"r"}'));
    await diagnoseOps(deadBundle);
    const sent = JSON.stringify(chatMock.mock.calls[0][0]);
    expect(sent).toContain('settlement.instruct');
    expect(sent).toContain('ECONNREFUSED');
    expect(sent).toContain('http');
    expect(sent).toMatch(/3 \(this row excluded\)/);
  });

  it('the stuck-transfer prompt carries the masked amount, age, and provider type', async () => {
    chatMock.mockResolvedValue(reply('{"failure_class":"unknown","suggested_action":"investigate","blast_radius":"isolated","rationale":"r"}'));
    await diagnoseOps(stuckBundle);
    const sent = JSON.stringify(chatMock.mock.calls[0][0]);
    expect(sent).toContain('txn_1');
    expect(sent).toContain('$100.00');
    expect(sent).toContain('45 minutes ago');
    expect(sent).toContain('simulator');
  });
});

describe('errorPrefix — deterministic normalization for sibling clustering', () => {
  it('normalizes whitespace and case, and slices to the prefix length', () => {
    expect(errorPrefix('  Fetch   FAILED: boom  ')).toBe('fetch failed: boom');
    expect(errorPrefix('ECONNREFUSED at 10.0.0.1', 12)).toBe('econnrefused');
  });

  it('two errors that differ only by a trailing id share a prefix', () => {
    const a = errorPrefix('Ollama request failed (502): upstream A timed out at 12:00', 30);
    const b = errorPrefix('Ollama request failed (502): upstream B timed out at 13:00', 30);
    expect(a).toBe(b);
  });

  it('empty / null errors return an empty prefix', () => {
    expect(errorPrefix(null)).toBe('');
    expect(errorPrefix(undefined)).toBe('');
    expect(errorPrefix('   ')).toBe('');
  });
});
