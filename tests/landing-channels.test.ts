import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHAT_CHANNELS, AI_APPS_GUIDE_HREF } from '@/app/landing/channels';

// Raj's follow-up (Oct 25): "add the delta new items of Telegram, AI-ChatGPT, Perplexity and
// Claude". Owner go: a "Choose your chat app" section with honest labels and no "testing" wording.
// WhatsApp is the only channel open to everyone; Telegram sits behind an admin switch and the AI
// apps are invite-only, so neither may read as available.

const PAGE = readFileSync(resolve(process.cwd(), 'src/app/page.tsx'), 'utf-8');

describe('CHAT_CHANNELS', () => {
  it('lists WhatsApp, Telegram and the AI apps, in that order', () => {
    expect(CHAT_CHANNELS.map((c) => c.id)).toEqual(['whatsapp', 'telegram', 'ai-apps']);
  });

  it('only WhatsApp is available now', () => {
    expect(CHAT_CHANNELS.filter((c) => c.status === 'available').map((c) => c.id)).toEqual(['whatsapp']);
    expect(CHAT_CHANNELS.find((c) => c.id === 'telegram')!.status).toBe('coming-soon');
    expect(CHAT_CHANNELS.find((c) => c.id === 'ai-apps')!.status).toBe('early-access');
  });

  it('names Claude, ChatGPT and Perplexity and links the AI apps guide', () => {
    const ai = CHAT_CHANNELS.find((c) => c.id === 'ai-apps')!;
    for (const app of ['Claude', 'ChatGPT', 'Perplexity']) expect(ai.title + ai.body).toContain(app);
    expect(AI_APPS_GUIDE_HREF).toBe('/docs/ai-apps');
  });

  it('says the AI app never pays: the customer pays on the pay page', () => {
    const ai = CHAT_CHANNELS.find((c) => c.id === 'ai-apps')!;
    expect(ai.body).toMatch(/you always pay on the SmartRemit pay page/i);
  });

  it('never says testing, testers or beta', () => {
    const text = CHAT_CHANNELS.map((c) => `${c.title} ${c.badge} ${c.body}`).join(' ');
    expect(text).not.toMatch(/\b(test|tests|testing|testers?|beta|pilot)\b/i);
  });
});

describe('landing page "Choose your chat app" section', () => {
  const at = PAGE.indexOf('id="channels"');
  const section = PAGE.slice(at, PAGE.indexOf('</section>', at));

  it('renders the section from CHAT_CHANNELS', () => {
    expect(at).toBeGreaterThan(-1);
    expect(section).toContain('Choose your chat app');
    expect(section).toContain('CHAT_CHANNELS.map(');
  });

  it('carries the trademark note for the named AI apps', () => {
    expect(section).toMatch(/Claude, ChatGPT and Perplexity are trademarks of their owners/);
  });

  it('the page has no "testing" wording anywhere', () => {
    expect(PAGE).not.toMatch(/\bin testing\b|\btesters?\b/i);
  });
});
