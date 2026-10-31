import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHAT_CHANNELS, AI_APPS_GUIDE_HREF, TELEGRAM_BOT_HREF } from '@/app/landing/channels';

// Raj's follow-up (Oct 25): "add the delta new items of Telegram, AI-ChatGPT, Perplexity and
// Claude". Owner go: a "Choose your chat app" section with honest labels and no "testing" wording.
// R20 / Q11 (owner, 2026-10-31): only WhatsApp is open to everyone. Telegram serves invited phones
// only (src/lib/telegram-inbound.ts), so it reads "By invitation"; the AI apps are invite-only
// early access and are not named on the home page (no platform permission to use their names).

const PAGE = readFileSync(resolve(process.cwd(), 'src/app/page.tsx'), 'utf-8');

describe('CHAT_CHANNELS', () => {
  it('lists WhatsApp, Telegram and the AI apps, in that order', () => {
    expect(CHAT_CHANNELS.map((c) => c.id)).toEqual(['whatsapp', 'telegram', 'ai-apps']);
  });

  it('only WhatsApp is available now; Telegram is by invitation; the AI apps are early access', () => {
    expect(CHAT_CHANNELS.filter((c) => c.status === 'available').map((c) => c.id)).toEqual(['whatsapp']);
    const telegram = CHAT_CHANNELS.find((c) => c.id === 'telegram')!;
    expect(telegram.status).toBe('by-invitation');
    expect(telegram.badge).toBe('By invitation');
    expect(telegram.body).toMatch(/invited/i);
    expect(CHAT_CHANNELS.find((c) => c.id === 'ai-apps')!.status).toBe('early-access');
    expect(CHAT_CHANNELS.filter((c) => c.badge === 'Available now').map((c) => c.id)).toEqual(['whatsapp']);
  });

  it('links the SmartRemit Telegram bot', () => {
    expect(TELEGRAM_BOT_HREF).toBe('https://t.me/smartremit_bot');
  });

  it('names no AI app (Q11) and links the AI apps guide', () => {
    const ai = CHAT_CHANNELS.find((c) => c.id === 'ai-apps')!;
    const text = CHAT_CHANNELS.map((c) => `${c.title} ${c.badge} ${c.body}`).join(' ');
    for (const app of ['Claude', 'ChatGPT', 'Perplexity', 'Gemini', 'Copilot']) expect(text).not.toContain(app);
    expect(ai.title).toBe('AI assistants');
    expect(ai.body).toMatch(/supports? custom connectors/i);
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
    expect(section).toContain('href={TELEGRAM_BOT_HREF}');
    expect(section).toContain('Start on Telegram');
  });

  it('the hero starts on WhatsApp, says Telegram is by invitation and names no AI app', () => {
    const squashed = PAGE.replace(/\s+/g, ' ');
    expect(squashed).toContain(
      'Start on <strong className="font-bold">WhatsApp</strong>.{\' \'} <strong className="font-bold">Telegram</strong> is open by invitation, and AI assistants that support custom connectors are in early access.',
    );
    expect(PAGE).not.toMatch(/\b(Claude|ChatGPT|Perplexity)\b/);
  });

  it('says SmartRemit is not endorsed by any AI app maker', () => {
    expect(section.replace(/\s+/g, ' ')).toContain('SmartRemit is not affiliated with or endorsed by any AI app maker.');
  });

  it('the page has no "testing" wording anywhere', () => {
    expect(PAGE).not.toMatch(/\bin testing\b|\btesters?\b/i);
  });
});
