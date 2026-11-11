import { t, type MessageKey } from '@/lib/i18n';
import { APEX_URL } from '@/lib/company';
import { AI_APPS_GUIDE_HREF } from '@/app/landing/channels';
import { Card } from '@/components/ds';
import { CopyAddress } from './copy-address';

// TGFL custom host (design §5.4): the "Connect an AI app" box at the top of /portal/ai-apps. It
// prints THIS host's MCP address (computed on the server from the canonical site host, so the
// custom host shows its own address), the steps per app (after src/content/docs/ai-apps.mdx), and
// an ABSOLUTE link to the full guide on the apex: a relative /docs link 404s on a site host.

const APPS = ['claude', 'chatgpt', 'perplexity'] as const;
type App = (typeof APPS)[number];

const key = (app: App, part: 'title' | 'step1' | 'step2' | 'step3'): MessageKey => `portal.agentApps.connector.${app}.${part}` as const;

export function ConnectorBox({ url }: { url: string }) {
  return (
    <section data-connector-box aria-labelledby="connector-title">
      <Card className="flex flex-col gap-4">
        <div>
          <h2 id="connector-title" className="text-[18px] font-bold text-ds-ink">
            {t('portal.agentApps.connector.title')}
          </h2>
          <p className="mt-1 text-[14px] text-ds-ink-muted">{t('portal.agentApps.connector.body')}</p>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-semibold uppercase tracking-wide text-ds-ink-muted">{t('portal.agentApps.connector.label')}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code data-connector-url className="select-all break-all rounded-ds-card border border-ds-border bg-ds-ground px-3 py-2 text-[14px] text-ds-ink">
              {url}
            </code>
            <CopyAddress
              text={url}
              label={t('portal.agentApps.connector.copy')}
              copiedLabel={t('portal.agentApps.connector.copied')}
              failedLabel={t('portal.agentApps.connector.copyFailed')}
              ariaLabel={t('portal.agentApps.connector.copyLabel')}
            />
          </div>
        </div>
        {APPS.map((app) => (
          <section key={app} id={`connect-${app}`} aria-labelledby={`connect-${app}-title`} className="scroll-mt-24">
            <h3 id={`connect-${app}-title`} className="text-[15px] font-semibold text-ds-ink">
              {t(key(app, 'title'))}
            </h3>
            <ol className="mt-1 list-decimal pl-5 text-[14px] text-ds-ink-muted">
              <li>{t(key(app, 'step1'))}</li>
              <li>{t(key(app, 'step2'))}</li>
              <li>{t(key(app, 'step3'))}</li>
            </ol>
          </section>
        ))}
        <p className="text-[12px] text-ds-ink-muted">{t('portal.agentApps.connector.disclaimer')}</p>
        <p className="text-[14px]">
          <a href={`${APEX_URL}${AI_APPS_GUIDE_HREF}`} className="font-semibold text-ds-primary hover:underline">
            {t('portal.agentApps.connector.guide')}
          </a>
        </p>
      </Card>
    </section>
  );
}
