import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { promptHash, stableJson } from '@/lib/ai-provenance';
import type { ChatTool } from '@/lib/types';

// R31: promptHash names the exact system prompt + tool schemas a model saw,
// so an eval report (and later R33's reply provenance) can say which prompt
// version it tested. Pure: no I/O.

const tool = (name: string, description: string, parameters: Record<string, unknown> = { type: 'object', properties: {} }): ChatTool => ({
  type: 'function',
  function: { name, description, parameters },
});

const TOOLS: ChatTool[] = [
  tool('get_quote', 'Quote a transfer.', { type: 'object', properties: { amount_source: { type: 'number' }, destination_country: { type: 'string' } }, required: ['amount_source'] }),
  tool('decline_off_topic', 'Decline a request that is not about sending money.'),
];

describe('promptHash', () => {
  it('is "p1:" plus the sha256 hex of system + NUL + the stable JSON of the tools', () => {
    const h = promptHash('You are the AI assistant.', TOOLS);
    expect(h).toMatch(/^p1:[0-9a-f]{64}$/);
    const expected = createHash('sha256').update(`You are the AI assistant.\u0000${stableJson(TOOLS)}`, 'utf8').digest('hex');
    expect(h).toBe(`p1:${expected}`);
  });

  it('is stable across object key order, at any depth', () => {
    const reordered: ChatTool[] = [
      {
        function: {
          parameters: { required: ['amount_source'], properties: { destination_country: { type: 'string' }, amount_source: { type: 'number' } }, type: 'object' },
          description: 'Quote a transfer.',
          name: 'get_quote',
        },
        type: 'function',
      },
      { function: { description: 'Decline a request that is not about sending money.', name: 'decline_off_topic', parameters: { properties: {}, type: 'object' } }, type: 'function' },
    ];
    expect(promptHash('S', reordered)).toBe(promptHash('S', TOOLS));
  });

  it('changes when one character of the prompt changes', () => {
    expect(promptHash('You are the AI assistant!', TOOLS)).not.toBe(promptHash('You are the AI assistant.', TOOLS));
  });

  it('changes when one character of a tool description or a parameter changes', () => {
    const base = promptHash('S', TOOLS);
    const desc = TOOLS.map((t, i) => (i === 1 ? tool(t.function.name, 'Decline a request that is not about sending money!') : t));
    expect(promptHash('S', desc)).not.toBe(base);
    const param = [tool('get_quote', 'Quote a transfer.', { type: 'object', properties: { amount_source: { type: 'integer' }, destination_country: { type: 'string' } }, required: ['amount_source'] }), TOOLS[1]];
    expect(promptHash('S', param)).not.toBe(base);
  });

  it('changes when the tool order changes (the model sees the list in order)', () => {
    expect(promptHash('S', [...TOOLS].reverse())).not.toBe(promptHash('S', TOOLS));
  });

  it('separates the prompt from the tools, so moving text across the boundary changes the hash', () => {
    expect(promptHash('S', [])).not.toBe(promptHash('', []));
    expect(promptHash('[]', [])).not.toBe(promptHash('', []));
  });
});

describe('stableJson', () => {
  it('sorts object keys, keeps array order, and drops undefined like JSON.stringify', () => {
    expect(stableJson({ b: 1, a: [3, { d: 1, c: undefined, b: null }] })).toBe('{"a":[3,{"b":null,"d":1}],"b":1}');
    expect(stableJson('x')).toBe('"x"');
    expect(stableJson([undefined])).toBe('[null]');
  });
});
