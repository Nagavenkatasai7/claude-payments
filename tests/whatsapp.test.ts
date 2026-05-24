import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseIncoming,
  sendText,
  sendTemplate,
  sendInteractive,
  RECIPIENT_TEMPLATE_NAME,
  RECIPIENT_TEMPLATE_LANG,
} from '@/lib/whatsapp';

afterEach(() => {
  vi.restoreAllMocks();
});

function textWebhook() {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  type: 'text',
                  from: '15551234567',
                  id: 'wamid.ABC',
                  text: { body: 'hello' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('parseIncoming', () => {
  it('extracts a text message as kind=text', () => {
    expect(parseIncoming(textWebhook())).toEqual({
      kind: 'text',
      from: '15551234567',
      text: 'hello',
      messageId: 'wamid.ABC',
    });
  });

  it('returns null for a non-text message', () => {
    const body = textWebhook();
    body.entry[0].changes[0].value.messages[0].type = 'image';
    expect(parseIncoming(body)).toBeNull();
  });

  it('returns null for an unrelated payload (e.g. status update)', () => {
    expect(parseIncoming({ entry: [{ changes: [{ value: {} }] }] })).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseIncoming(null)).toBeNull();
    expect(parseIncoming({})).toBeNull();
  });
});

describe('sendText', () => {
  it('posts a text message to the Graph API', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendText('15551234567', 'hi');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/123456/messages');
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe('15551234567');
    expect(body.text.body).toBe('hi');
  });

  it('throws when the Graph API responds with an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => 'bad request',
      })),
    );
    await expect(sendText('1', 'hi')).rejects.toThrow(/400/);
  });
});

describe('sendTemplate', () => {
  it('posts a template message to the Graph API with type "template"', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendTemplate(
      '919876543210',
      RECIPIENT_TEMPLATE_NAME,
      RECIPIENT_TEMPLATE_LANG,
      ['Mom', '42,600', '+15551234567', 'UPI ID'],
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/123456/messages');
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('template');
    expect(body.to).toBe('919876543210');
    expect(body.template.name).toBe(RECIPIENT_TEMPLATE_NAME);
    expect(body.template.language.code).toBe(RECIPIENT_TEMPLATE_LANG);
    const params = body.template.components[0].parameters;
    expect(params).toHaveLength(4);
    expect(params[0]).toEqual({ type: 'text', text: 'Mom' });
    expect(params[1]).toEqual({ type: 'text', text: '42,600' });
    expect(params[2]).toEqual({ type: 'text', text: '+15551234567' });
    expect(params[3]).toEqual({ type: 'text', text: 'UPI ID' });
  });

  it('uses the correct template name and language code constants', async () => {
    expect(RECIPIENT_TEMPLATE_NAME).toBe('transfer_delivered');
    expect(RECIPIENT_TEMPLATE_LANG).toBe('en');
  });

  it('throws when the Graph API responds with an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => 'template not approved',
      })),
    );
    await expect(
      sendTemplate('1', 'transfer_delivered', 'en_US', ['a', 'b', 'c', 'd']),
    ).rejects.toThrow(/WhatsApp template send failed.*400/);
  });
});

function buttonWebhook() {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  type: 'interactive',
                  from: '15551234567',
                  id: 'wamid.BTN',
                  interactive: {
                    type: 'button_reply',
                    button_reply: { id: 'approve:abc12345', title: 'Approve & pay' },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('parseIncoming (interactive)', () => {
  it('extracts a button reply as kind=button', () => {
    expect(parseIncoming(buttonWebhook())).toEqual({
      kind: 'button',
      from: '15551234567',
      buttonId: 'approve:abc12345',
      messageId: 'wamid.BTN',
    });
  });

  it('returns null when interactive payload is missing button_reply', () => {
    const body = buttonWebhook();
    body.entry[0].changes[0].value.messages[0].interactive = {
      type: 'list_reply',
    } as unknown as { type: 'button_reply'; button_reply: { id: string; title: string } };
    expect(parseIncoming(body)).toBeNull();
  });

  it('wraps a text message as kind=text', () => {
    expect(parseIncoming(textWebhook())).toEqual({
      kind: 'text',
      from: '15551234567',
      text: 'hello',
      messageId: 'wamid.ABC',
    });
  });
});

describe('sendInteractive', () => {
  it('posts a button-type interactive message with the expected shape', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendInteractive('15551234567', 'Who are we sending to?', [
      { id: 'recipient:919876543210', title: 'Mom' },
      { id: 'recipient:new', title: 'Someone new' },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/123456/messages');
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('interactive');
    expect(body.interactive.type).toBe('button');
    expect(body.interactive.body.text).toContain('Who are we sending to?');
    expect(body.interactive.action.buttons).toHaveLength(2);
    expect(body.interactive.action.buttons[0].reply.id).toBe('recipient:919876543210');
    expect(body.interactive.action.buttons[0].reply.title).toBe('Mom');
  });

  it('falls back to sendText on HTTP 470 (24h window)', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit): Promise<{ ok: boolean; status?: number; text: () => Promise<string> }> => {
        calls.push(JSON.parse(init.body as string).type);
        if (calls.length === 1) return { ok: false, status: 470, text: async () => 'engagement' };
        return { ok: true, text: async () => '' };
      }),
    );

    await sendInteractive('15551234567', 'Pick one', [
      { id: 'recipient:919876543210', title: 'Mom' },
    ]);

    expect(calls).toEqual(['interactive', 'text']);
  });

  it('throws on non-470 errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, text: async () => 'bad' })),
    );
    await expect(
      sendInteractive('1', 'pick', [{ id: 'recipient:new', title: 'New' }]),
    ).rejects.toThrow(/400/);
  });
});
