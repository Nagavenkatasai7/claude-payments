import { describe, it, expect } from 'vitest';
import { parseWebhook, parseIncoming, parsePhoneNumberId, parseStatusEvent } from '@/lib/whatsapp';

// R1: parseWebhook walks EVERY entry[], changes[] and messages[] — nothing in a
// webhook POST is silently skipped. parseIncoming / parsePhoneNumberId /
// parseStatusEvent stay thin wrappers pinned to entry[0].changes[0].

const text = (from: string, id: string, body: string) => ({ from, id, type: 'text', text: { body } });
const env = (...entries: unknown[]) => ({ object: 'whatsapp_business_account', entry: entries });
const change = (value: Record<string, unknown>) => ({ changes: [{ field: 'messages', value }] });

describe('parseWebhook', () => {
  it('two messages in one change ⇒ both, in order', () => {
    const body = env(change({ metadata: { phone_number_id: 'pn1' }, messages: [text('1555', 'w1', 'a'), text('1555', 'w2', 'b')] }));
    const out = parseWebhook(body);
    expect(out).toHaveLength(1);
    expect(out[0].pnid).toBe('pn1');
    expect(out[0].messages.map((m) => m.messageId)).toEqual(['w1', 'w2']);
    expect(out[0].messages[1]).toMatchObject({ kind: 'text', from: '1555', text: 'b' });
  });

  it('two entries (two numbers) ⇒ two changes, each with its own pnid', () => {
    const body = env(
      change({ metadata: { phone_number_id: 'pnA' }, messages: [text('1555', 'wa', 'hi')] }),
      change({ metadata: { phone_number_id: 'pnB' }, messages: [text('1666', 'wb', 'yo')] }),
    );
    const out = parseWebhook(body);
    expect(out.map((c) => c.pnid)).toEqual(['pnA', 'pnB']);
    expect(out.map((c) => c.messages[0].messageId)).toEqual(['wa', 'wb']);
  });

  it('two changes in one entry are both read', () => {
    const body = env({ changes: [
      { value: { messages: [text('1555', 'c1', 'x')] } },
      { value: { messages: [text('1555', 'c2', 'y')] } },
    ] });
    expect(parseWebhook(body).flatMap((c) => c.messages.map((m) => m.messageId))).toEqual(['c1', 'c2']);
  });

  it('statuses AND messages in one POST ⇒ both are returned (a status first never hides a message)', () => {
    const body = env(
      change({ statuses: [{ id: 's1', recipient_id: '1555', status: 'delivered' }] }),
      change({ messages: [text('1555', 'w9', 'hi')], statuses: [{ id: 's2', recipient_id: '1555', status: 'read' }] }),
    );
    const out = parseWebhook(body);
    expect(out[0].statuses.map((s) => s.wamid)).toEqual(['s1']);
    expect(out[0].messages).toEqual([]);
    expect(out[1].messages.map((m) => m.messageId)).toEqual(['w9']);
    expect(out[1].statuses.map((s) => s.status)).toEqual(['read']);
  });

  it('`from` absent with from_user_id present ⇒ dropped as no_phone (booleans only), never a message', () => {
    const body = env(change({
      contacts: [{ user_id: 'US.123', profile: { name: 'N', username: '@someone' } }],
      messages: [{ from_user_id: 'US.123', id: 'wx', type: 'text', text: { body: 'hi' } }],
    }));
    const [c] = parseWebhook(body);
    expect(c.messages).toEqual([]);
    expect(c.dropped).toEqual([{ reason: 'no_phone', messageId: 'wx', hasBsuid: true, hasUsername: true }]);
    expect(JSON.stringify(c.dropped)).not.toContain('US.123');
    expect(JSON.stringify(c.dropped)).not.toContain('someone');
  });

  it('`from` absent and no BSUID ⇒ dropped with hasBsuid false', () => {
    const [c] = parseWebhook(env(change({ messages: [{ id: 'wy', type: 'text', text: { body: 'hi' } }] })));
    expect(c.dropped).toEqual([{ reason: 'no_phone', messageId: 'wy', hasBsuid: false, hasUsername: false }]);
  });

  it('a message with `from` also carries the optional bsuid/username (from_user_id, else contacts[].user_id)', () => {
    const direct = parseWebhook(env(change({
      contacts: [{ wa_id: '1555', user_id: 'US.C', profile: { username: '@u' } }],
      messages: [{ ...text('1555', 'w1', 'hi'), from_user_id: 'US.M' }],
    })))[0].messages[0];
    expect(direct).toMatchObject({ from: '1555', bsuid: 'US.M', username: '@u' });
    const viaContact = parseWebhook(env(change({
      contacts: [{ wa_id: '1555', user_id: 'US.C' }],
      messages: [text('1555', 'w2', 'hi')],
    })))[0].messages[0];
    expect(viaContact).toMatchObject({ bsuid: 'US.C' });
    expect(viaContact).not.toHaveProperty('username');
    const plain = parseWebhook(env(change({ messages: [text('1555', 'w3', 'hi')] })))[0].messages[0];
    expect(plain).toEqual({ kind: 'text', from: '1555', text: 'hi', messageId: 'w3' });
  });

  it('messages[].timestamp (unix seconds) becomes sentAtMs; absent or garbage ⇒ no field', () => {
    const [c] = parseWebhook(env(change({ messages: [
      { ...text('1555', 'w1', 'a'), timestamp: '1700000000' },
      { ...text('1555', 'w2', 'b'), timestamp: 'soon' },
      text('1555', 'w3', 'c'),
    ] })));
    expect(c.messages[0].sentAtMs).toBe(1_700_000_000_000);
    expect(c.messages[1]).not.toHaveProperty('sentAtMs');
    expect(c.messages[2]).not.toHaveProperty('sentAtMs');
  });

  it('value.errors are surfaced (code/title/message only)', () => {
    const [c] = parseWebhook(env(change({ errors: [{ code: 131051, title: 'Unsupported message type', message: 'm', extra: 1 }] })));
    expect(c.errors).toEqual([{ code: 131051, title: 'Unsupported message type', message: 'm' }]);
  });

  it('ignored types (reaction) are neither messages nor dropped', () => {
    const [c] = parseWebhook(env(change({ messages: [{ from: '1555', id: 'wr', type: 'reaction', reaction: { emoji: 'x' } }] })));
    expect(c.messages).toEqual([]);
    expect(c.dropped).toEqual([]);
  });

  it('garbage never throws', () => {
    for (const b of [null, undefined, 'x', 42, {}, { entry: 'x' }, { entry: [null, { changes: [null, { value: null }] }] }]) {
      expect(() => parseWebhook(b)).not.toThrow();
    }
    expect(parseWebhook(null)).toEqual([]);
  });
});

describe('thin wrappers stay pinned to entry[0].changes[0]', () => {
  const two = env(
    change({ metadata: { phone_number_id: 'pnA' }, messages: [text('1555', 'wa', 'hi')] }),
    change({ metadata: { phone_number_id: 'pnB' }, messages: [text('1666', 'wb', 'yo')], statuses: [{ id: 's', status: 'read' }] }),
  );
  it('parseIncoming ⇒ the first message only; parsePhoneNumberId ⇒ entry[0]; parseStatusEvent ⇒ null (entry[0] has none)', () => {
    expect(parseIncoming(two)).toEqual({ kind: 'text', from: '1555', text: 'hi', messageId: 'wa' });
    expect(parsePhoneNumberId(two)).toBe('pnA');
    expect(parseStatusEvent(two)).toBeNull();
  });
});
