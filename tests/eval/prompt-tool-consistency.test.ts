import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSystemPrompt, SYSTEM_PROMPT } from '@/lib/prompt';
import { toolSchemas, toolSchemasForChannel } from '@/lib/tools';
import { EVAL_CASES, UNVERIFIED_SENDER_NOTE } from '../../scripts/eval-bot-cases';

// Program-Fix 49B (prompt-11): static consistency between what the system
// prompt tells the model and what the WhatsApp tool schemas tell it. The two
// reach the model in the same context window, so a contradiction here is a
// coin-flip in production (audit prompt-05, seven contradictions).

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const whatsapp = toolSchemasForChannel('whatsapp');
const whatsappNames = new Set(whatsapp.map((t) => t.function.name));
const allToolNames = toolSchemas.map((t) => t.function.name);
const describeTool = (n: string) => whatsapp.find((t) => t.function.name === n)?.function.description ?? '';

const PROMPTS = {
  gateOn: SYSTEM_PROMPT,
  gateOffOurs: buildSystemPrompt({ brand: 'SmartRemit', kycGateActive: false, kycMode: 'ours' }),
  gateOffDelegated: buildSystemPrompt({ brand: 'SmartRemit', kycGateActive: false, kycMode: 'delegated' }),
};

describe('prompt ↔ WhatsApp tool schemas (Program-Fix 49B)', () => {
  it.each(Object.entries(PROMPTS))('%s: every tool the prompt names is one the model can see, or is named only to forbid it', (_, prompt) => {
    for (const name of allToolNames) {
      if (!prompt.includes(name) || whatsappNames.has(name)) continue;
      // A hidden tool may appear only in a "do NOT call <tool>" sentence.
      for (const sentence of prompt.split(/(?<=[.!?])\s+|\n/).filter((s) => s.includes(name))) {
        expect(sentence, `${name}: "${sentence}"`).toMatch(new RegExp(`(do not|never) call ${name}`, 'i'));
      }
    }
  });

  it('funding: the prompt says bank transfer only, so no schema offers a card', () => {
    expect(SYSTEM_PROMPT).toContain('it is ALWAYS bank transfer');
    const json = JSON.stringify(whatsapp);
    expect(json).not.toMatch(/credit_card|debit_card/);
    expect(describeTool('send_approve_picker')).not.toMatch(/funding method/i);
  });

  it('greeting: the prompt forbids a picker merely to greet; list_saved_recipients agrees', () => {
    expect(SYSTEM_PROMPT).toContain('Do NOT call list_saved_recipients or send_recipient_picker merely to greet');
    expect(describeTool('list_saved_recipients')).not.toMatch(/first message/i);
  });

  it('cancel: the card has no Cancel button; cancel_draft says the customer replies "cancel"', () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('reply "cancel"');
    expect(describeTool('cancel_draft')).not.toContain('[Cancel]');
  });

  it('rate lock: no schema or prompt claims a 10-minute lock', () => {
    for (const text of [JSON.stringify(whatsapp), ...Object.values(PROMPTS)]) {
      expect(text).not.toMatch(/locked (for )?(about |~)?10 min/i);
    }
  });

  it('the [RECIPIENT SELECTED] note agent.ts injects does not ask for a funding method', () => {
    const agent = read('src/lib/agent.ts');
    const note = agent.slice(agent.indexOf('[RECIPIENT SELECTED] The customer tapped'), agent.indexOf('[RECIPIENT SELECTED] The customer tapped') + 600);
    expect(note).toContain('[RECIPIENT SELECTED]');
    expect(note).not.toMatch(/funding method/i);
  });
});

describe('the recorded eval set (scripts/eval-bot-cases.ts) stays true to the app', () => {
  it('is the 15 audit cases, ids 1..15', () => {
    expect(EVAL_CASES.map((c) => c.id)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('the server notes it replays are still what agent.ts injects', () => {
    const agent = read('src/lib/agent.ts').replace(/'\s*\+\s*\n\s*'/g, '');
    expect(agent).toContain(UNVERIFIED_SENDER_NOTE);
  });

  it('every tool a case records or expects exists (a renamed tool fails here, not in the nightly run)', () => {
    const known = new Set(allToolNames);
    for (const c of EVAL_CASES) {
      for (const m of [...c.history, c.recorded.pass, c.recorded.fail]) {
        for (const call of m.tool_calls ?? []) expect(known.has(call.function.name), `#${c.id} ${call.function.name}`).toBe(true);
      }
    }
  });

  it('carries no real-looking phone number outside the fixture set', () => {
    const src = read('scripts/eval-bot-cases.ts');
    const numbers = [...src.matchAll(/\b\d{11,13}\b/g)].map((m) => m[0]);
    for (const n of numbers) expect(['919876543210', '525555550101', '15555550199'], n).toContain(n);
  });
});
