import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatClient, DEFAULT_CHAT_COPY, DEFAULT_CHAT_ENDPOINT, postChatMessage } from '@/app/account/chat/chat-client';

// UI redesign M2-12, Task 12.3: the legacy /account chat client gains an `endpoint` prop (and the
// portal's t() copy) so /portal/chat reuses it. The legacy default is unchanged.

describe('ChatClient reuse', () => {
  it('the default endpoint is still the legacy /api/account/chat', () => {
    expect(DEFAULT_CHAT_ENDPOINT).toBe('/api/account/chat');
  });

  it('with no props it renders the legacy copy', () => {
    const html = renderToStaticMarkup(createElement(ChatClient));
    expect(html).toContain('Ask about your transfers, limits, saved recipients, refunds — or repeat a past send.');
    expect(html).toContain('placeholder="Type a message"');
    expect(html).toContain('aria-label="Message"');
    expect(html).toContain('>Send</button>');
    expect(DEFAULT_CHAT_COPY.genericError).toBe('Something went wrong — please try again.');
  });

  it('renders the copy it is given', () => {
    const copy = { ...DEFAULT_CHAT_COPY, intro: 'Portal intro', placeholder: 'Portal placeholder', send: 'Go' };
    const html = renderToStaticMarkup(createElement(ChatClient, { endpoint: '/api/portal/chat', copy }));
    expect(html).toContain('Portal intro');
    expect(html).toContain('placeholder="Portal placeholder"');
    expect(html).toContain('>Go</button>');
  });
});

describe('postChatMessage', () => {
  it('POSTs the message as JSON to the given endpoint and returns the reply', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ reply: 'hi' }), { status: 200 }));
    expect(await postChatMessage('/api/portal/chat', 'hello', 'generic', fetchImpl as unknown as typeof fetch)).toEqual({ reply: 'hi' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/portal/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
  });

  it("returns the server's error text, else the generic copy", async () => {
    const withError = vi.fn(async () => new Response(JSON.stringify({ error: 'capped' }), { status: 429 }));
    expect(await postChatMessage('/x', 'a', 'generic', withError as unknown as typeof fetch)).toEqual({ error: 'capped' });
    const bare404 = vi.fn(async () => new Response(null, { status: 404 }));
    expect(await postChatMessage('/x', 'a', 'generic', bare404 as unknown as typeof fetch)).toEqual({ error: 'generic' });
  });
});
