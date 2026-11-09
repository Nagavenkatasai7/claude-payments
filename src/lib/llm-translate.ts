import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatTool, ToolCall } from './types';

// llm-translate — our provider-neutral chat shape (the OpenAI-style
// ChatMessage the agent, the helpers and the 30-day Redis history use) to the
// Claude Messages API and back. Pure; no I/O.
//
// Claude rules this file keeps (Messages API reference; the SDK types in
// node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts):
//  - system text goes in the top-level `system` field, never in `messages`;
//  - a tool call is a `tool_use` block in an assistant message, and its result
//    is a `tool_result` block in the NEXT user message; every tool_use needs a
//    result there, and a result needs its tool_use, or the request is a 400;
//  - all results of one round ride in ONE user message;
//  - `messages` starts with a user message and never ends with an assistant
//    message (an assistant prefill is a 400 on these models);
//  - tool ids match ^[a-zA-Z0-9_-]+$ (history from the old provider may not);
//  - thinking blocks of the current turn go back unchanged (ChatMessage
//    .providerContent carries them between rounds; it is never persisted).

type Block = Anthropic.ContentBlockParam;
type ToolResult = Anthropic.ToolResultBlockParam;

export interface AnthropicChatRequest {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

/** Tool-result text for a call that has no result (a turn cut short mid-round). */
export const MISSING_RESULT_TEXT = 'This step did not run.';

export function safeToolId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return s || 'tool';
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The blocks, and the id each tool_use had before safeToolId (a result names that id). */
function assistantBlocks(m: ChatMessage): { blocks: Block[]; rawIds: string[] } {
  if (Array.isArray(m.providerContent) && m.providerContent.length > 0) {
    const blocks = m.providerContent as Block[];
    const rawIds = blocks.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use').map((b) => b.id);
    return { blocks, rawIds };
  }
  const blocks: Block[] = [];
  const rawIds: string[] = [];
  const text = (m.content ?? '').trim();
  if (text) blocks.push({ type: 'text', text });
  for (const call of m.tool_calls ?? []) {
    blocks.push({ type: 'tool_use', id: safeToolId(call.id), name: call.function.name, input: parseArgs(call.function.arguments) });
    rawIds.push(call.id);
  }
  return { blocks, rawIds };
}

/**
 * Translate a chat to a Claude request. The FIRST system message is the fixed
 * prompt and gets the cache breakpoint (tools + that prompt are the shared
 * cached prefix); later system messages are per-turn notes after it.
 */
export function toAnthropicRequest(messages: ChatMessage[], tools: ChatTool[]): AnthropicChatRequest {
  const system: Anthropic.TextBlockParam[] = [];
  const out: Anthropic.MessageParam[] = [];
  // The open round's tool_use ids awaiting a result: `id` as sent, `raw` as
  // the history names it, `base` after safeToolId.
  let pending: { id: string; raw: string; base: string; answered: boolean }[] = [];
  let results: ToolResult[] = [];
  // Every tool_use id in this request. Claude wants them unique, but stored
  // history can repeat one after safeToolId (two empty ids, or 'a.b' and
  // 'a:b'): a repeat gets _2, _3, … so one bad old message cannot fail every
  // turn of the chat. A well-formed history never hits a repeat.
  const used = new Set<string>();
  const uniqueId = (base: string): string => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    return id;
  };

  const takeResults = (): ToolResult[] => {
    const all = [...results];
    for (const p of pending) {
      if (!p.answered) all.push({ type: 'tool_result', tool_use_id: p.id, content: MISSING_RESULT_TEXT, is_error: true });
    }
    pending = [];
    results = [];
    return all;
  };

  for (const m of messages) {
    if (m.role === 'system') {
      const text = (m.content ?? '').trim();
      if (text) system.push({ type: 'text', text });
      continue;
    }
    if (m.role === 'tool') {
      const raw = m.tool_call_id ?? '';
      const base = safeToolId(raw);
      // The first unanswered call with this exact id, else with the same safe
      // id. A result with no open tool_use (or one more than its calls) is dropped.
      const open = pending.find((p) => !p.answered && p.raw === raw) ?? pending.find((p) => !p.answered && p.base === base);
      if (open) {
        open.answered = true;
        results.push({ type: 'tool_result', tool_use_id: open.id, content: m.content || '(no output)' });
      }
      continue;
    }
    if (m.role === 'user') {
      const content: Block[] = pending.length > 0 ? takeResults() : [];
      const text = (m.content ?? '').trim();
      if (text) content.push({ type: 'text', text });
      if (content.length > 0) out.push({ role: 'user', content });
      continue;
    }
    // assistant
    if (pending.length > 0) out.push({ role: 'user', content: takeResults() });
    const { blocks: built, rawIds } = assistantBlocks(m);
    if (built.length === 0) continue;
    let call = 0;
    const blocks = built.map((b) => {
      if (b.type !== 'tool_use') return b;
      const id = uniqueId(b.id);
      pending.push({ id, raw: rawIds[call++] ?? b.id, base: b.id, answered: false });
      return id === b.id ? b : { ...b, id };
    });
    out.push({ role: 'assistant', content: blocks });
  }
  if (pending.length > 0) out.push({ role: 'user', content: takeResults() });

  // Start with a user message that is not only tool results.
  while (out.length > 0) {
    const first = out[0];
    if (first.role === 'assistant') {
      out.shift();
      continue;
    }
    const kept = (first.content as Block[]).filter((b) => b.type !== 'tool_result');
    if (kept.length === 0) {
      out.shift();
      continue;
    }
    out[0] = { role: 'user', content: kept };
    break;
  }
  // Never end on an assistant message (a prefill): drop a trailing text-only one.
  while (out.length > 0 && out[out.length - 1].role === 'assistant') out.pop();

  if (system.length > 0) system[0] = { ...system[0], cache_control: { type: 'ephemeral' } };

  return {
    system,
    messages: out,
    tools: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
    })),
  };
}

/**
 * A Claude response as our ChatMessage. Text blocks join into `content`;
 * tool_use blocks become `tool_calls`; `providerContent` keeps the blocks
 * (thinking included) so the next round of the SAME turn sends them back
 * unchanged. Server-tool blocks never occur: we declare no server tools.
 */
export function fromAnthropicMessage(msg: Pick<Anthropic.Message, 'content'>): ChatMessage {
  const providerContent: Block[] = [];
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') {
      texts.push(b.text);
      providerContent.push({ type: 'text', text: b.text });
    } else if (b.type === 'thinking') {
      providerContent.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
    } else if (b.type === 'redacted_thinking') {
      providerContent.push({ type: 'redacted_thinking', data: b.data });
    } else if (b.type === 'tool_use') {
      toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
      providerContent.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    }
  }
  const message: ChatMessage = { role: 'assistant', content: texts.join('\n').trim() };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (providerContent.length > 0) message.providerContent = providerContent;
  return message;
}

/** History as it is persisted: no provider blocks (they belong to one turn). */
export function stripProviderContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.providerContent === undefined) return m;
    const { providerContent: _drop, ...rest } = m;
    return rest;
  });
}
