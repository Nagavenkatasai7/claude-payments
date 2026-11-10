import Link from 'next/link';
import { Bot, MessageCircle, Send } from 'lucide-react';
import { t, type MessageKey } from '@/lib/i18n';
import { Badge, Button, Card, type Tone } from '@/components/ds';
import type { WayBadge, WayId, WayToSend } from '@/lib/portal-ways-to-send';

// TGFL custom host (design §5.3): the "Ways to send" card on the portal home. A server component;
// the list comes from waysToSend() (src/lib/portal-ways-to-send.ts). SmartRemit is the name of
// every channel, also on a skin host. External links open in a new tab, with no opener.

const BADGE: Record<WayBadge, { key: MessageKey; tone: Tone }> = {
  available: { key: 'portal.home.ways.badge.available', tone: 'success' },
  byInvitation: { key: 'portal.home.ways.badge.byInvitation', tone: 'neutral' },
  earlyAccess: { key: 'portal.home.ways.badge.earlyAccess', tone: 'info' },
};

const CTA: Record<WayId, MessageKey> = {
  whatsapp: 'portal.home.ways.whatsappCta',
  telegram: 'portal.home.ways.telegramCta',
  claude: 'portal.home.ways.aiCta',
  chatgpt: 'portal.home.ways.aiCta',
  perplexity: 'portal.home.ways.aiCta',
};

function WayLink({ way }: { way: WayToSend & { href: string } }) {
  const name = t(way.nameKey);
  if (way.external) {
    const Icon = way.id === 'whatsapp' ? MessageCircle : Send;
    return (
      <Button asChild size="sm" variant={way.id === 'whatsapp' ? 'whatsapp' : 'ghost'}>
        <a href={way.href} target="_blank" rel="noopener noreferrer">
          <Icon aria-hidden="true" className="size-4" />
          {t(CTA[way.id])}
        </a>
      </Button>
    );
  }
  return (
    <Button asChild size="sm" variant="ghost">
      <Link href={way.href} aria-label={`${t(CTA[way.id])}: ${name}`}>
        <Bot aria-hidden="true" className="size-4" />
        {t(CTA[way.id])}
      </Link>
    </Button>
  );
}

export function WaysToSendCard({ ways }: { ways: readonly WayToSend[] }) {
  const anyAi = ways.some((w) => w.id === 'claude' || w.id === 'chatgpt' || w.id === 'perplexity');
  return (
    <section data-ways-to-send aria-labelledby="ways-title">
      <Card className="flex flex-col gap-4">
        <div>
          <h2 id="ways-title" className="text-[18px] font-bold text-ds-ink">
            {t('portal.home.ways.title')}
          </h2>
          <p className="mt-1 text-[14px] text-ds-ink-muted">{t('portal.home.ways.body')}</p>
        </div>
        {ways.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {ways.map((w) => {
              const badge = BADGE[w.badge];
              return (
                <li key={w.id} data-way={w.id} className="flex flex-col gap-2 rounded-ds-card border border-ds-border p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-ds-ink">
                      {t(w.nameKey)}
                      <Badge tone={badge.tone}>{t(badge.key)}</Badge>
                    </p>
                    <p className="mt-1 text-[13.5px] text-ds-ink-muted">{t(w.noteKey)}</p>
                  </div>
                  {w.href !== null ? <WayLink way={{ ...w, href: w.href }} /> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <p className="text-[13px] text-ds-ink-muted">{t('portal.home.ways.payNote')}</p>
        {anyAi ? <p className="text-[12px] text-ds-ink-muted">{t('portal.home.ways.disclaimer')}</p> : null}
      </Card>
    </section>
  );
}
