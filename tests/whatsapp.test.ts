import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseIncoming,
  parseStatusEvent,
  sendText,
  sendTemplate,
  sendInteractive,
  sendList,
  sendCtaUrl,
  sendTemplateWithButton,
  sendTemplateOrText,
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

function statusWebhook(
  statuses: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    entry: [{ changes: [{ value: { statuses } }] }],
  };
}

describe('parseStatusEvent', () => {
  it('returns null for a messages-only (non-status) webhook', () => {
    expect(parseStatusEvent(textWebhook())).toBeNull();
  });

  it('returns null for malformed / empty input', () => {
    expect(parseStatusEvent(null)).toBeNull();
    expect(parseStatusEvent({})).toBeNull();
    expect(parseStatusEvent(statusWebhook([]))).toBeNull();
  });

  it('parses a delivered status', () => {
    const evs = parseStatusEvent(
      statusWebhook([
        {
          id: 'wamid.D1',
          recipient_id: '15551230000',
          status: 'delivered',
          timestamp: '1700000000',
        },
      ]),
    );
    expect(evs).toEqual([
      {
        wamid: 'wamid.D1',
        recipientId: '15551230000',
        status: 'delivered',
        timestamp: '1700000000',
      },
    ]);
  });

  it('parses a read status', () => {
    const evs = parseStatusEvent(
      statusWebhook([
        { id: 'wamid.R1', recipient_id: '15551230000', status: 'read' },
      ]),
    );
    expect(evs?.[0].status).toBe('read');
  });

  it('parses a failed status and surfaces the error code + title', () => {
    const evs = parseStatusEvent(
      statusWebhook([
        {
          id: 'wamid.F1',
          recipient_id: '15551230000',
          status: 'failed',
          errors: [
            {
              code: 131056,
              title: 'Too many messages',
              message: 'rate limited',
            },
          ],
        },
      ]),
    );
    expect(evs).toHaveLength(1);
    expect(evs?.[0]).toMatchObject({
      wamid: 'wamid.F1',
      recipientId: '15551230000',
      status: 'failed',
      errorCode: 131056,
      errorTitle: 'Too many messages',
    });
  });

  it('returns every status when the value carries multiple', () => {
    const evs = parseStatusEvent(
      statusWebhook([
        { id: 'wamid.1', recipient_id: '15551230000', status: 'sent' },
        { id: 'wamid.2', recipient_id: '15551230000', status: 'delivered' },
      ]),
    );
    expect(evs).toHaveLength(2);
    expect(evs?.map((e) => e.status)).toEqual(['sent', 'delivered']);
  });

  it('skips malformed status entries missing id or status', () => {
    const evs = parseStatusEvent(
      statusWebhook([
        { recipient_id: '15551230000', status: 'delivered' }, // no id
        { id: 'wamid.OK', recipient_id: '15551230000', status: 'read' },
        { id: 'wamid.NOSTATUS', recipient_id: '15551230000' }, // no status
      ]),
    );
    expect(evs).toEqual([
      { wamid: 'wamid.OK', recipientId: '15551230000', status: 'read' },
    ]);
  });
});

describe('parseIncoming + parseStatusEvent disjoint', () => {
  it('a statuses-only webhook is null for parseIncoming (status branch owns it)', () => {
    const body = statusWebhook([
      { id: 'wamid.X', recipient_id: '15551230000', status: 'delivered' },
    ]);
    expect(parseIncoming(body)).toBeNull();
    expect(parseStatusEvent(body)).not.toBeNull();
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

  it('throws IMMEDIATELY on a non-rate-limit 400 (single fetch, no retry)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendText('1', 'hi')).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('rate-limit backoff (131056 / HTTP 429)', () => {
  it('retries on a 131056 error body, then resolves on success', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"error":{"code":131056}}',
      })
      .mockResolvedValueOnce({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p = sendText('15551230000', 'hi');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('retries on HTTP 429, then resolves on success', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValueOnce({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p = sendText('15551230000', 'hi');
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('gives up and throws after exhausting retries on persistent 131056', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":{"code":131056}}',
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p = sendText('15551230000', 'hi');
    // attach a rejection handler before advancing timers so it's not unhandled
    const assertion = expect(p).rejects.toThrow(/131056/);
    await vi.runAllTimersAsync();
    await assertion;
    // 1 initial attempt + 2 retries = 3 total
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('does NOT retry on success (single fetch)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    await sendText('15551230000', 'hi');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sendTemplate also retries on 131056', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'error 131056 too many messages',
      })
      .mockResolvedValueOnce({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p = sendTemplate('919876543210', 'transfer_delivered', 'en', ['a', 'b', 'c', 'd']);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
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

describe('sendTemplateWithButton', () => {
  it('posts a 2-component template: body params + a url button param', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendTemplateWithButton(
      '919876543210',
      'scheduled_payment_ready',
      'en',
      ['Anand', '$100.00', 'Priya'],
      'tx_a1b2c3',
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('scheduled_payment_ready');
    const components = body.template.components;
    expect(components).toHaveLength(2);
    expect(components[0].type).toBe('body');
    expect(components[0].parameters).toEqual([
      { type: 'text', text: 'Anand' },
      { type: 'text', text: '$100.00' },
      { type: 'text', text: 'Priya' },
    ]);
    expect(components[1]).toEqual({
      type: 'button',
      sub_type: 'url',
      index: 0,
      parameters: [{ type: 'text', text: 'tx_a1b2c3' }],
    });
  });

  it('throws on a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, text: async () => 'template not found' })),
    );
    await expect(
      sendTemplateWithButton('1', 'scheduled_payment_ready', 'en', ['a'], 'tok'),
    ).rejects.toThrow(/template send failed.*404/);
  });
});

describe('sendTemplateOrText', () => {
  it('does NOT call sendText when the template send succeeds', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    let sendCalled = false;
    await sendTemplateOrText(
      '919876543210',
      async () => {
        sendCalled = true;
      },
      'fallback body',
    );

    expect(sendCalled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled(); // no sendText
  });

  it('falls back to sendText (type "text", fallback body) when the template send rejects', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendTemplateOrText(
      '919876543210',
      async () => {
        throw new Error('template not approved');
      },
      'fallback body',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('text');
    expect(body.text.body).toBe('fallback body');
    expect(warn).toHaveBeenCalled();
  });

  it('swallows (does not throw) when the fallback sendText also fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 470, text: async () => 're-engagement' })),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      sendTemplateOrText(
        '919876543210',
        async () => {
          throw new Error('template not approved');
        },
        'fallback body',
      ),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
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

describe('sendList — richer interactive list, sendInteractive-shaped envelope', () => {
  it('POSTs the Graph v21.0 messages endpoint with an interactive list body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await sendList('15551230000', 'Who are we sending to?', 'Choose', [
      { id: 'recipient:919876543210', title: 'Mom' },
      { id: 'recipient:new', title: 'Someone new' },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v21.0/');
    expect(url).toContain('/messages');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.messaging_product).toBe('whatsapp');
    expect(sent.type).toBe('interactive');
    expect(sent.interactive.type).toBe('list');
    // row ids carry the SAME grammar parseButtonId already understands
    const rowIds = sent.interactive.action.sections
      .flatMap((s: { rows: { id: string }[] }) => s.rows).map((r: { id: string }) => r.id);
    expect(rowIds).toContain('recipient:919876543210');
    expect(rowIds).toContain('recipient:new');
  });

  it('falls back to sendText on HTTP 470 (24h window), like sendInteractive', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 470, text: async () => 'window' })
      .mockResolvedValueOnce({ ok: true, status: 200 }); // the sendText retry
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendList('15551230000', 'Body', 'Choose', [
      { id: 'recipient:new', title: 'Someone new' },
    ])).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(second.type).toBe('text'); // fell back to plain text with the options listed
  });

  it('throws on a non-OK, non-470 status (so the caller can fall back to buttons)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' });
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendList('15551230000', 'Body', 'Choose', [
      { id: 'recipient:new', title: 'Someone new' },
    ])).rejects.toThrow();
  });
});

describe('sendCtaUrl', () => {
  it('POSTs interactive.type "cta_url" with action.name "cta_url" + parameters.display_text + parameters.url', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendCtaUrl(
      '15551234567',
      'Tap below to pay',
      { displayText: 'Pay now', url: 'https://example.com/pay/abc' },
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/v21.0/');
    expect(url).toContain('/messages');
    const body = JSON.parse(init.body as string);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('15551234567');
    expect(body.type).toBe('interactive');
    expect(body.interactive.type).toBe('cta_url');
    expect(body.interactive.body.text).toBe('Tap below to pay');
    expect(body.interactive.action.name).toBe('cta_url');
    expect(body.interactive.action.parameters.display_text).toBe('Pay now');
    expect(body.interactive.action.parameters.url).toBe('https://example.com/pay/abc');
  });

  it('includes optional header and footer when passed', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    await sendCtaUrl(
      '15551234567',
      'Body text',
      { displayText: 'Open link', url: 'https://example.com/link' },
      'Header text',
      'Footer text',
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.interactive.header).toEqual({ type: 'text', text: 'Header text' });
    expect(body.interactive.footer).toEqual({ text: 'Footer text' });
  });

  it('throws when url is not https://', async () => {
    await expect(
      sendCtaUrl('15551234567', 'Body', { displayText: 'Go', url: 'http://example.com' }),
    ).rejects.toThrow('sendCtaUrl: URL must be https://');
  });

  it('throws when displayText is longer than 20 chars', async () => {
    await expect(
      sendCtaUrl('15551234567', 'Body', { displayText: 'This is way too long!', url: 'https://example.com' }),
    ).rejects.toThrow('sendCtaUrl: displayText must be <= 20 chars');
  });

  it('on HTTP 470, falls back to sendText (second fetch posts type "text")', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit): Promise<{ ok: boolean; status?: number; text: () => Promise<string> }> => {
        calls.push(JSON.parse(init.body as string).type);
        if (calls.length === 1) return { ok: false, status: 470, text: async () => 'engagement' };
        return { ok: true, text: async () => '' };
      }),
    );

    await sendCtaUrl(
      '15551234567',
      'Tap below to pay',
      { displayText: 'Pay now', url: 'https://example.com/pay/abc' },
    );

    expect(calls).toEqual(['interactive', 'text']);
  });

  it('on ANY non-OK error (e.g. 400 unsupported type), falls back to sendText instead of throwing', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit): Promise<{ ok: boolean; status?: number; text: () => Promise<string> }> => {
        calls.push(JSON.parse(init.body as string).type);
        if (calls.length === 1) return { ok: false, status: 400, text: async () => 'unsupported message type' };
        return { ok: true, text: async () => '' };
      }),
    );

    // Must NOT throw — degrade gracefully to a text message with the link.
    await sendCtaUrl('15551234567', 'Tap below to pay', { displayText: 'Pay now', url: 'https://example.com/pay/abc' });
    expect(calls).toEqual(['interactive', 'text']);
  });
});

describe('parseIncoming — list_reply collapses to the existing button shape', () => {
  it('a list_reply yields { kind: "button", buttonId } (same shape as button_reply)', () => {
    const msg = parseIncoming({
      entry: [{ changes: [{ value: { messages: [{
        type: 'interactive', from: '15551230000', id: 'wamid.1',
        interactive: { type: 'list_reply', list_reply: { id: 'recipient:919876543210', title: 'Mom' } },
      }] } }] }],
    });
    expect(msg).toEqual({ kind: 'button', from: '15551230000',
      buttonId: 'recipient:919876543210', messageId: 'wamid.1' });
  });
  it('returns null for a list_reply missing its id (defensive)', () => {
    const msg = parseIncoming({
      entry: [{ changes: [{ value: { messages: [{
        type: 'interactive', from: '15551230000', id: 'wamid.2',
        interactive: { type: 'list_reply', list_reply: {} },
      }] } }] }],
    });
    expect(msg).toBeNull();
  });
  it('still parses a button_reply exactly as before (regression)', () => {
    const msg = parseIncoming({
      entry: [{ changes: [{ value: { messages: [{
        type: 'interactive', from: '15551230000', id: 'wamid.3',
        interactive: { type: 'button_reply', button_reply: { id: 'recipient:new', title: 'Someone new' } },
      }] } }] }],
    });
    expect(msg).toEqual({ kind: 'button', from: '15551230000', buttonId: 'recipient:new', messageId: 'wamid.3' });
  });
});
