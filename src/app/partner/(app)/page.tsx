import Link from 'next/link';
import type { Metadata } from 'next';
import { requirePartnerStaff } from '@/lib/auth';
import { PARTNER_ROUTES, routeAllows } from '../routes';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { env } from '@/lib/env';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { getPartnerApiKeyStore } from '@/lib/partner-api-key';
import { getChannelHealth, summarizeChannelHealth } from '@/lib/channel-health';
import { readSignatureHealth, type SignatureHealth } from '@/lib/webhook-signature-health';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { buildPartnerHome, settlementHealth, whatsappHealth, type HealthState } from '@/lib/partner-home';
import { contactAvailable, countWaitingTeamQuestions, listTenantTickets, QUEUE_LIMIT } from '@/lib/partner-tickets';
import { PageHeader, buttonVariants } from '@/components/ds';
import { ActionList, HealthCard, KpiRow } from './home-sections';

export const metadata: Metadata = { title: t('partner.home.title'), robots: { index: false, follow: false } };

// /partner (home, UI redesign M3-3) inside the M3-2 shell (the layout owns the main landmark and
// runs with skipMfa, so it fetches no tenant data). This page gates on every render, then reads
// each source with the SESSION tenant (ctx.partnerId), never a param. Read-only: no writes.

// A failed source is logged (ids only, scrubbed) and becomes null: its card shows an error state
// and the rest of the page renders. The wrapper is async, so a synchronous throw from a store
// getter is caught too.
async function safe<T>(source: string, partnerId: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    logWarn('partner.home', err, { source, partnerId });
    return null;
  }
}

async function readWhatsapp(partnerId: string): Promise<HealthState> {
  const now = new Date();
  // As the legacy partner page does (admin-dashboard/partners/[id]/page.tsx): the default tenant IS
  // the shared number, so its marks are the platform's, not a partner signal.
  const isDefault = partnerId === DEFAULT_PARTNER_ID;
  const [view, signature] = await Promise.all([
    getChannelHealth(partnerId, { store: getStore(), db: getDb() }),
    isDefault ? Promise.resolve<SignatureHealth>({}) : readSignatureHealth(partnerId),
  ]);
  return whatsappHealth(
    summarizeChannelHealth({ channel: view.channel, marks: isDefault ? {} : view.marks, now, signature }),
  );
}

async function readSettlement(partnerId: string): Promise<HealthState> {
  const integrations = await getPartnerIntegrationsStore().getIntegrations(partnerId);
  return settlementHealth(integrations.payment, { appOrigin: env.appBaseUrl, production: env.isProduction });
}

export default async function PartnerHomePage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.home.policy);
  const pid = ctx.partnerId;
  // Lost-features A12: admins see how many team questions wait for them (a bounded tenant read).
  const readsTeamQuestions = ctx.role === 'admin' && contactAvailable(pid);
  const [summary, whatsapp, settlement, apiKeys, teamQuestions] = await Promise.all([
    // Live rows only; "today" is the ledger's America/New_York day (transfer-repo.ts summary()).
    safe('summary', pid, () => getStore().transfersSummary(pid)),
    safe('whatsapp', pid, () => readWhatsapp(pid)),
    safe('settlement', pid, () => readSettlement(pid)),
    safe('api_keys', pid, () => getPartnerApiKeyStore().list(pid)),
    readsTeamQuestions
      ? safe('team_questions', pid, async () =>
          countWaitingTeamQuestions(await listTenantTickets(pid, { kind: 'internal', limit: QUEUE_LIMIT }), ctx.username),
        )
      : Promise.resolve(undefined),
  ]);
  const model = buildPartnerHome({ role: ctx.role, summary, whatsapp, settlement, apiKeys, teamQuestions, now: new Date() });

  return (
    <>
      <PageHeader
        title={t('partner.home.title')}
        sub={t('partner.home.sub')}
        actions={
          <Link href={PARTNER_ROUTES.security.href} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            {t('partner.home.securityLink')}
          </Link>
        }
      />
      <div className="grid gap-4 lg:gap-6">
        {model.kpis !== null ? (
          <KpiRow kpis={model.kpis} reviewsHref={routeAllows('reviews', ctx.role) ? PARTNER_ROUTES.reviews.href : null} />
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
          <ActionList actions={model.actions} incomplete={model.actionsIncomplete} />
          <HealthCard health={model.health} />
        </div>
      </div>
    </>
  );
}
