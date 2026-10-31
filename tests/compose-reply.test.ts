import { describe, it, expect } from 'vitest';
import { composeReply } from '@/lib/compose-reply';

// PR1 (critic resolution): one fixed order for every model reply:
// [redaction notice][risk warning] model text [code-written quote_text].
// The reply guard and the FALLBACK check read the raw model text before this
// runs; links are appended after it by the agent.

describe('composeReply', () => {
  it('puts the parts in the fixed order, a blank line apart', () => {
    expect(
      composeReply({
        redactionNotice: 'We hid a card number you typed.',
        riskWarning: 'Scam check: never send money to someone you have not met.',
        modelText: 'Here is your quote. Shall I go ahead?',
        quoteText: 'Sending $500.00.\nFee $1.99',
      }),
    ).toBe(
      'We hid a card number you typed.\n\nScam check: never send money to someone you have not met.\n\n' +
        'Here is your quote. Shall I go ahead?\n\nSending $500.00.\nFee $1.99',
    );
  });

  it('leaves out empty slots, so a plain reply is unchanged', () => {
    expect(composeReply({ modelText: 'Hi there!' })).toBe('Hi there!');
    expect(composeReply({ modelText: '  Hi there!  ', quoteText: '', riskWarning: '   ' })).toBe('Hi there!');
  });

  it('never doubles a warning or a quote the model already wrote word for word', () => {
    const w = 'Scam check: never send money to someone you have not met.';
    const q = 'Sending $500.00.\nFee $1.99';
    expect(composeReply({ riskWarning: w, modelText: `${w}\n\nOk.` })).toBe(`${w}\n\nOk.`);
    expect(composeReply({ modelText: `Here it is:\n${q}`, quoteText: q })).toBe(`Here it is:\n${q}`);
  });

  it('a reply of only code text still reads in order when the model text is empty', () => {
    expect(composeReply({ riskWarning: 'Warning.', modelText: '', quoteText: 'Sending $5.00.' })).toBe('Warning.\n\nSending $5.00.');
    expect(composeReply({ modelText: '' })).toBe('');
  });
});
