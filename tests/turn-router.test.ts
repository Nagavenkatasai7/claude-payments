import { describe, it, expect } from 'vitest';
import { routeTurn, pausedReply } from '@/lib/turn-router';
import { offTopicReply } from '@/lib/scope-guard';

// The ONE ordered router every chat turn goes through before the model (PR1:
// R26's paused slot, then R43's HELP intents, then R56's off-topic check, then
// the model). Pure: the worker and the web chat act on the route it returns.

describe('routeTurn', () => {
  it('HELP and a request for a person skip the model', () => {
    expect(routeTurn({ text: 'HELP' })).toEqual({ kind: 'help', match: { intent: 'help', lang: 'en' } });
    expect(routeTurn({ text: 'I want to talk to a human' })).toMatchObject({ kind: 'help', match: { intent: 'human' } });
    expect(routeTurn({ text: 'my money did not arrive' })).toMatchObject({ kind: 'help', match: { intent: 'money_problem' } });
  });

  it('a clear off-topic request gets the fixed decline, in the customer language', () => {
    expect(routeTurn({ text: 'write me a python script' })).toEqual({ kind: 'off_topic', lang: 'en' });
    expect(routeTurn({ text: 'escríbeme un poema' })).toEqual({ kind: 'off_topic', lang: 'es' });
    expect(offTopicReply('es')).not.toBe(offTopicReply('en'));
  });

  it('everything else reaches the model; a cancel request is flagged and still reaches it', () => {
    expect(routeTurn({ text: 'send $100 to Mom' })).toEqual({ kind: 'model', cancel: null });
    expect(routeTurn({ text: 'are you a real person?' })).toEqual({ kind: 'model', cancel: null });
    expect(routeTurn({ text: 'hi' })).toEqual({ kind: 'model', cancel: null });
    expect(routeTurn({ text: 'cancel my transfer' })).toEqual({ kind: 'model', cancel: { intent: 'cancel', lang: 'en' } });
  });

  it('HELP comes before the off-topic check', () => {
    // "help" is an on-topic word for the scope guard as well, but the HELP route must win.
    expect(routeTurn({ text: 'help' }).kind).toBe('help');
  });

  it('a button tap always reaches the model (its synthesized text is ours, not the customer)', () => {
    expect(routeTurn({ text: 'cancel', isButtonTap: true })).toEqual({ kind: 'model', cancel: null });
    expect(routeTurn({ text: 'HELP', isButtonTap: true })).toEqual({ kind: 'model', cancel: null });
  });

  it('a paused agent (R26 slot) answers with the fixed menu, but HELP still reaches a person', () => {
    expect(routeTurn({ text: 'send $100 to Mom', paused: true })).toEqual({ kind: 'paused' });
    expect(routeTurn({ text: 'write me a poem', paused: true })).toEqual({ kind: 'paused' });
    expect(routeTurn({ text: 'cancel', paused: true })).toEqual({ kind: 'paused' });
    expect(routeTurn({ text: 'HELP', paused: true })).toMatchObject({ kind: 'help' });
    expect(routeTurn({ text: 'HELP', isButtonTap: true, paused: true })).toEqual({ kind: 'paused' });
  });

  it('never throws on odd input', () => {
    expect(routeTurn({ text: undefined })).toEqual({ kind: 'model', cancel: null });
    expect(routeTurn({ text: '' })).toEqual({ kind: 'model', cancel: null });
    expect(routeTurn({ text: 42 })).toEqual({ kind: 'model', cancel: null });
  });
});

describe('pausedReply', () => {
  it('offers HELP in each language and names no partner', () => {
    for (const lang of ['en', 'hinglish', 'es'] as const) {
      const t = pausedReply(lang);
      expect(t).toContain('HELP');
      expect(t.toLowerCase()).not.toContain('partner');
      expect(t).not.toMatch(/\d/);
    }
  });
});
