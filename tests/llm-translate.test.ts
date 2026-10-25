import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  MISSING_RESULT_TEXT,
  fromAnthropicMessage,
  safeToolId,
  stripProviderContent,
  toAnthropicRequest,
} from '@/lib/llm-translate';
import type { ChatMessage, ChatTool } from '@/lib/types';

const TOOL: ChatTool = {
  type: 'function',
  function: { name: 'get_quote', description: 'Quote a send', parameters: { type: 'object', properties: { amount_usd: { type: 'number' } } } },
};

const call = (id: string, name = 'get_quote', args = '{"amount_usd":100}') => ({
  id,
  type: 'function' as const,
  function: { name, arguments: args },
});

describe('toAnthropicRequest', () => {
  it('moves system messages to `system` and caches the first one (the fixed prompt)', () => {
    const req = toAnthropicRequest(
      [
        { role: 'system', content: 'RULES' },
        { role: 'system', content: '[WEB CHAT] note' },
        { role: 'user', content: 'hi' },
      ],
      [],
    );
    expect(req.system).toEqual([
      { type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '[WEB CHAT] note' },
    ]);
    expect(req.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('maps tools to name / description / input_schema, names unchanged', () => {
    const req = toAnthropicRequest([{ role: 'user', content: 'hi' }], [TOOL]);
    expect(req.tools).toEqual([
      { name: 'get_quote', description: 'Quote a send', input_schema: TOOL.function.parameters },
    ]);
  });

  it('a tool round: tool_use in the assistant message, all results in ONE user message', () => {
    const req = toAnthropicRequest(
      [
        { role: 'user', content: 'send 100' },
        { role: 'assistant', content: 'Let me check.', tool_calls: [call('a1'), call('a2', 'check_send_limit', '{}')] },
        { role: 'tool', tool_call_id: 'a1', content: '{"rate":83}' },
        { role: 'tool', tool_call_id: 'a2', content: '{"ok":true}' },
      ],
      [TOOL],
    );
    expect(req.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'send 100' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'a1', name: 'get_quote', input: { amount_usd: 100 } },
          { type: 'tool_use', id: 'a2', name: 'check_send_limit', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a1', content: '{"rate":83}' },
          { type: 'tool_result', tool_use_id: 'a2', content: '{"ok":true}' },
        ],
      },
    ]);
  });

  it('a user message right after tool results joins the same user message, results first', () => {
    const req = toAnthropicRequest(
      [
        { role: 'user', content: 'quote' },
        { role: 'assistant', content: '', tool_calls: [call('a1')] },
        { role: 'tool', tool_call_id: 'a1', content: '{}' },
        { role: 'user', content: 'and to Mom?' },
      ],
      [],
    );
    expect(req.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a1', content: '{}' },
        { type: 'text', text: 'and to Mom?' },
      ],
    });
  });

  it('a call cut short (no result saved) gets an error result, never a dangling tool_use', () => {
    const req = toAnthropicRequest(
      [
        { role: 'user', content: 'quote' },
        { role: 'assistant', content: '', tool_calls: [call('a1'), call('a2')] },
        { role: 'tool', tool_call_id: 'a1', content: '{}' },
        { role: 'user', content: 'hello?' },
      ],
      [],
    );
    expect(req.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'a1', content: '{}' },
      { type: 'tool_result', tool_use_id: 'a2', content: MISSING_RESULT_TEXT, is_error: true },
      { type: 'text', text: 'hello?' },
    ]);
  });

  it('drops a tool result that has no open tool_use, and a duplicate result', () => {
    const req = toAnthropicRequest(
      [
        { role: 'user', content: 'hi' },
        { role: 'tool', tool_call_id: 'ghost', content: '{}' },
        { role: 'assistant', content: '', tool_calls: [call('a1')] },
        { role: 'tool', tool_call_id: 'a1', content: 'first' },
        { role: 'tool', tool_call_id: 'a1', content: 'second' },
      ],
      [],
    );
    expect(req.messages).toHaveLength(3);
    expect(req.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'a1', content: 'first' }]);
  });

  it('old-provider ids with dots and colons become valid Claude ids on both sides', () => {
    expect(safeToolId('functions.get_quote:0')).toBe('functions_get_quote_0');
    const req = toAnthropicRequest(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', tool_calls: [call('functions.get_quote:0')] },
        { role: 'tool', tool_call_id: 'functions.get_quote:0', content: '{}' },
      ],
      [],
    );
    const use = (req.messages[1].content as Anthropic.ContentBlockParam[])[0] as Anthropic.ToolUseBlockParam;
    const result = (req.messages[2].content as Anthropic.ContentBlockParam[])[0] as Anthropic.ToolResultBlockParam;
    expect(use.id).toBe('functions_get_quote_0');
    expect(result.tool_use_id).toBe('functions_get_quote_0');
  });

  it('bad tool-call JSON becomes {} input, never a throw', () => {
    const req = toAnthropicRequest(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', tool_calls: [call('a1', 'get_quote', '{oops')] },
        { role: 'tool', tool_call_id: 'a1', content: '{}' },
      ],
      [],
    );
    expect((req.messages[1].content as Anthropic.ToolUseBlockParam[])[0].input).toEqual({});
  });

  it('starts with a user message and never ends on an assistant message (no prefill)', () => {
    const req = toAnthropicRequest(
      [
        { role: 'assistant', content: 'stale greeting' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello!' },
      ],
      [],
    );
    expect(req.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('skips empty assistant messages and empty user text', () => {
    const req = toAnthropicRequest(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '' },
        { role: 'user', content: '   ' },
        { role: 'user', content: 'again' },
      ],
      [],
    );
    expect(req.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ]);
  });

  it('sends providerContent (thinking blocks) back unchanged within a turn', () => {
    const blocks = [
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_quote', input: { amount_usd: 50 } },
    ];
    const req = toAnthropicRequest(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', tool_calls: [call('toolu_1')], providerContent: blocks },
        { role: 'tool', tool_call_id: 'toolu_1', content: '{}' },
      ],
      [],
    );
    expect(req.messages[1]).toEqual({ role: 'assistant', content: blocks });
    expect(req.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{}' }]);
  });
});

describe('fromAnthropicMessage', () => {
  it('joins text, maps tool_use to tool_calls and keeps the blocks for the next round', () => {
    const msg = fromAnthropicMessage({
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: 'One moment.', citations: null },
        { type: 'tool_use', id: 'toolu_9', name: 'get_quote', input: { amount_usd: 20 }, caller: { type: 'direct' } },
      ] as unknown as Anthropic.ContentBlock[],
    });
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('One moment.');
    expect(msg.tool_calls).toEqual([
      { id: 'toolu_9', type: 'function', function: { name: 'get_quote', arguments: '{"amount_usd":20}' } },
    ]);
    expect(msg.providerContent).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'One moment.' },
      { type: 'tool_use', id: 'toolu_9', name: 'get_quote', input: { amount_usd: 20 } },
    ]);
  });

  it('a plain reply has no tool_calls', () => {
    const msg = fromAnthropicMessage({ content: [{ type: 'text', text: 'Hi!', citations: null }] as Anthropic.ContentBlock[] });
    expect(msg.content).toBe('Hi!');
    expect(msg.tool_calls).toBeUndefined();
  });

  it('round-trips: a translated reply goes back as the same blocks', () => {
    const reply = fromAnthropicMessage({
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'get_quote', input: {} }] as unknown as Anthropic.ContentBlock[],
    });
    const req = toAnthropicRequest(
      [{ role: 'user', content: 'q' }, reply, { role: 'tool', tool_call_id: 'toolu_2', content: '{}' }],
      [],
    );
    expect(req.messages[1].content).toEqual([{ type: 'tool_use', id: 'toolu_2', name: 'get_quote', input: {} }]);
  });
});

describe('stripProviderContent', () => {
  it('removes provider blocks and leaves everything else', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', providerContent: [{ type: 'thinking' }] },
    ];
    expect(stripProviderContent(history)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
  });
});
