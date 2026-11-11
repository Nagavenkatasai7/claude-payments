import { describe, it, expect } from 'vitest';
import { waysToSend, type WaysInput } from '@/lib/portal-ways-to-send';
import { t } from '@/lib/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WaysToSendCard } from '@/app/portal/ways-to-send-card';

// TGFL custom host, design §5.1 / §6 item 25: the portal home's "Ways to send" list. Honest per
// tenant (the shared WhatsApp and Telegram bots belong to the 'default' tenant), per switch
// (telegram.bot, agent.tools) and per customer (the AI apps link only while /portal/ai-apps shows).

const WA = 'https://api.whatsapp.com/send/?phone=1&text=hi&type=phone_number&app_absent=0';
const TG = 'https://t.me/smartremit_bot';
const base: WaysInput = { sharedBot: true, agentPaused: false, whatsappHref: WA, telegramOn: false, telegramHref: TG, aiSwitchOn: false, aiAppsOn: false };
const ids = (i: Partial<WaysInput>) => waysToSend({ ...base, ...i }).map((w) => w.id);

describe('waysToSend', () => {
  it('order is fixed: whatsapp, telegram, claude, chatgpt, perplexity', () => {
    expect(ids({ telegramOn: true, aiSwitchOn: true, aiAppsOn: true })).toEqual(['whatsapp', 'telegram', 'claude', 'chatgpt', 'perplexity']);
  });

  it('the default tenant shows WhatsApp, available, external, linked to the given href', () => {
    const [wa] = waysToSend(base);
    expect(wa).toMatchObject({ id: 'whatsapp', badge: 'available', href: WA, external: true });
    expect(ids({})).toEqual(['whatsapp']);
  });

  it('a partner tenant hides WhatsApp and Telegram (they are SmartRemit\'s own bots)', () => {
    expect(ids({ sharedBot: false, telegramOn: true })).toEqual([]);
    expect(ids({ sharedBot: false, telegramOn: true, aiSwitchOn: true })).toEqual(['claude', 'chatgpt', 'perplexity']);
  });

  it('Telegram needs sharedBot AND telegramOn, and always says by invitation', () => {
    expect(ids({ telegramOn: false })).not.toContain('telegram');
    const tg = waysToSend({ ...base, telegramOn: true }).find((w) => w.id === 'telegram');
    expect(tg).toMatchObject({ badge: 'byInvitation', href: TG, external: true });
  });

  it('agent.paused on (the bot answers only the fixed reply) → no WhatsApp and no Telegram; the AI apps follow their own switch', () => {
    expect(ids({ agentPaused: true, telegramOn: true })).toEqual([]);
    expect(ids({ agentPaused: true, telegramOn: true, aiSwitchOn: true, aiAppsOn: true })).toEqual(['claude', 'chatgpt', 'perplexity']);
    expect(ids({ agentPaused: false, telegramOn: true })).toEqual(['whatsapp', 'telegram']);
  });

  it('agent.tools off → no AI entries, even when the customer could see /portal/ai-apps', () => {
    expect(ids({ aiSwitchOn: false, aiAppsOn: true })).toEqual(['whatsapp']);
  });

  it('switch on and the page visible → each AI app links to its section, internal, early access', () => {
    const ai = waysToSend({ ...base, aiSwitchOn: true, aiAppsOn: true }).filter((w) => w.id !== 'whatsapp');
    expect(ai.map((w) => [w.id, w.href, w.badge, w.external])).toEqual([
      ['claude', '/portal/ai-apps#connect-claude', 'earlyAccess', false],
      ['chatgpt', '/portal/ai-apps#connect-chatgpt', 'earlyAccess', false],
      ['perplexity', '/portal/ai-apps#connect-perplexity', 'earlyAccess', false],
    ]);
  });

  it('switch on, gate shut → names with no link, by invitation', () => {
    const ai = waysToSend({ ...base, aiSwitchOn: true, aiAppsOn: false }).filter((w) => w.id !== 'whatsapp');
    expect(ai).toHaveLength(3);
    for (const w of ai) expect(w).toMatchObject({ href: null, badge: 'byInvitation', external: false });
  });

  it('every name and note renders through t() with no forbidden word', () => {
    const all = [
      ...waysToSend({ ...base, telegramOn: true, aiSwitchOn: true, aiAppsOn: true }),
      ...waysToSend({ ...base, telegramOn: true, aiSwitchOn: true, aiAppsOn: false }),
    ];
    for (const w of all) {
      for (const text of [t(w.nameKey), t(w.noteKey)]) {
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/\b(test|testing|beta|pilot|instant)\b|in minutes/i);
      }
    }
  });
});

// Whole-branch review F9: the card is honest about what it lists.
describe('WaysToSendCard', () => {
  const card = (i: Partial<WaysInput>) => renderToStaticMarkup(createElement(WaysToSendCard, { ways: waysToSend({ ...base, ...i }) }));

  it('nothing to list (a partner tenant, agent.tools off) → no card at all', () => {
    expect(card({ sharedBot: false, aiSwitchOn: false })).toBe('');
  });

  it('no AI app listed → the pay-page sentence without the AI-app sentence or the disclaimer', () => {
    const html = card({ aiSwitchOn: false });
    expect(html).toContain('data-ways-to-send');
    expect(html).toContain(t('portal.home.ways.payNote'));
    expect(html).not.toContain(t('portal.home.ways.aiPayNote'));
    expect(html).not.toContain('not affiliated');
  });

  it('an AI app listed → the AI-app sentence and the disclaimer too', () => {
    const html = card({ aiSwitchOn: true, aiAppsOn: false });
    expect(html).toContain(t('portal.home.ways.aiPayNote'));
    expect(html).toContain(t('portal.home.ways.payNote'));
    expect(html).toContain('not affiliated');
    expect(`${t('portal.home.ways.aiPayNote')} ${t('portal.home.ways.payNote')}`).not.toMatch(/\b(test|testing)\b/i);
  });
});
