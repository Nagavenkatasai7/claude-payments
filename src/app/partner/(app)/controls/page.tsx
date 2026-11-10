import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { requirePartnerStaff } from '@/lib/auth';
import { t, type MessageKey } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { getDb } from '@/db/client';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { loadLiveReadinessFacts } from '@/db/repos/live-certification-facts';
import { getPartnerStore } from '@/lib/partner-store';
import { isLiveCertified } from '@/lib/live-gate';
import { liveReadiness, type LiveReadiness, type LiveReadinessLine } from '@/lib/live-certification';
import { capabilityRows, controlsView, type CapabilityRow, type ControlsPlatformLine, type ControlsSwitch } from '@/lib/partner-controls-view';
import { Badge, Card, PageHeader } from '@/components/ds';
import { PARTNER_ROUTES } from '../../routes';
import { CapabilityForm, SwitchForm } from './switch-form';

export const metadata: Metadata = {
  title: t('partner.controls.title'),
  robots: { index: false, follow: false },
};

// /partner/controls (fix pack 3 T11, R26 R13; contract 18). Admin only; the page gates itself (the
// layout's gate is chrome only) and reads the SESSION tenant only. Three sections, each read in its
// own try so one failure shows only that section's unavailable line:
//   1. switches: every feature_flags row through controlsView (this tenant's own rows with its own
//      username; platform rows as read-only 'Set by SmartRemit' lines, no form);
//   2. live features: the stored opt-ins through capabilityRows (booleans, the approver's own
//      username and a date; never a counsel reference);
//   3. readiness: the twelve live-money lines (facts loaded on the ROOT handle, never in a tx).
// Renders booleans, dates and this tenant's own usernames only: never a reason, a platform username
// or a contract or counsel reference. Viewing writes nothing.

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const day = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : '');

const SWITCH_COPY: Record<string, { label: MessageKey; desc: MessageKey }> = {
  'sends.paused': { label: 'partner.controls.switch.sends.paused.label', desc: 'partner.controls.switch.sends.paused.desc' },
  'settlement.paused': { label: 'partner.controls.switch.settlement.paused.label', desc: 'partner.controls.switch.settlement.paused.desc' },
  'agent.paused': { label: 'partner.controls.switch.agent.paused.label', desc: 'partner.controls.switch.agent.paused.desc' },
  'agent.tools.paused': { label: 'partner.controls.switch.agent.tools.paused.label', desc: 'partner.controls.switch.agent.tools.paused.desc' },
};

const CAP_LABEL: Record<CapabilityRow['cap'], MessageKey> = {
  b2b: 'partner.controls.optin.cap.b2b',
  usdc: 'partner.controls.optin.cap.usdc',
  telegram: 'partner.controls.optin.cap.telegram',
  mcp: 'partner.controls.optin.cap.mcp',
  schedules: 'partner.controls.optin.cap.schedules',
};

const STATE_LABEL: Record<LiveReadinessLine['state'], MessageKey> = {
  pass: 'partner.live.state.pass',
  fail: 'partner.live.state.fail',
  not_built: 'partner.live.state.notBuilt',
};

function platformScope(p: ControlsPlatformLine): string {
  if (p.scope === 'global') return t('partner.controls.scope.global');
  if (p.scope === 'partner') return t('partner.controls.scope.partner');
  return t('partner.controls.scope.corridor', { corridor: p.corridor ?? '' });
}

function Unavailable({ messageKey }: { messageKey: MessageKey }) {
  return (
    <p role="alert" className="mt-2 text-[14px] leading-relaxed text-ds-ink">
      {t(messageKey)}
    </p>
  );
}

function SwitchCard({ s }: { s: ControlsSwitch }) {
  const copy = SWITCH_COPY[s.key];
  const on = s.workspace.on || s.corridors.length > 0;
  return (
    <Card as="li" className="p-5 sm:p-6">
      <div data-testid="partner-controls-switch" data-key={s.key}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[16px] font-semibold text-ds-ink">{copy ? t(copy.label) : s.key}</h3>
          <Badge tone={on ? 'danger' : 'neutral'}>{t(on ? 'partner.controls.on' : 'partner.controls.off')}</Badge>
        </div>
        {copy ? <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{t(copy.desc)}</p> : null}
        {s.platform.map((p, i) => (
          <p key={`p${i}`} className="mt-2 text-[14px] font-semibold text-ds-danger-ink">
            {t('partner.controls.setBySmartRemit', { scope: platformScope(p) })}
          </p>
        ))}
        {s.workspace.on ? (
          <>
            <p className="mt-2 text-[14px] text-ds-ink">{t('partner.controls.pausedBy', { who: s.workspace.by ?? '', date: day(s.workspace.at) })}</p>
            <SwitchForm switchKey={s.key} enabled="off" />
          </>
        ) : (
          <SwitchForm switchKey={s.key} enabled="on" corridorChoice={s.tenantCorridor} />
        )}
        {s.corridors.map((c) => (
          <div key={c.corridor} className="mt-4 border-t border-ds-border pt-3">
            <p className="text-[14px] font-semibold text-ds-ink">{t('partner.controls.corridorLine', { corridor: c.corridor })}</p>
            <p className="text-[14px] text-ds-ink">{t('partner.controls.pausedBy', { who: c.by, date: day(c.at) })}</p>
            <SwitchForm switchKey={s.key} enabled="off" corridor={c.corridor} />
          </div>
        ))}
      </div>
    </Card>
  );
}

export default async function PartnerControlsPage() {
  const ctx = await requirePartnerStaff(PARTNER_ROUTES.controls.policy);
  const db = getDb();

  let switches: ControlsSwitch[] | null = null;
  try {
    switches = controlsView(await createFeatureFlagRepo(db).listAll(), ctx.partnerId);
  } catch (err) {
    logWarn('partner.controls.page', errName(err), { source: 'switches', partnerId: ctx.partnerId });
  }

  let caps: { rows: CapabilityRow[]; certified: boolean } | null = null;
  try {
    const partner = await getPartnerStore().getPartner(ctx.partnerId);
    if (!partner) throw new Error('partner_missing');
    const certified = isLiveCertified(partner);
    caps = { rows: capabilityRows(partner.liveControls, certified), certified };
  } catch (err) {
    logWarn('partner.controls.page', errName(err), { source: 'capabilities', partnerId: ctx.partnerId });
  }

  let readiness: LiveReadiness | null = null;
  try {
    // The ROOT handle, never a transaction (contract 8); loaded before the partner re-read below.
    const facts = await loadLiveReadinessFacts(db, ctx.partnerId, new Date());
    const partner = await getPartnerStore().getPartner(ctx.partnerId);
    if (!partner) throw new Error('partner_missing');
    readiness = liveReadiness(partner, facts);
  } catch (err) {
    logWarn('partner.controls.page', errName(err), { source: 'readiness', partnerId: ctx.partnerId });
  }

  let switchBody: ReactNode;
  if (!switches) switchBody = <Unavailable messageKey="partner.controls.unavailable" />;
  else
    switchBody = (
      <ul className="mt-3 flex flex-col gap-3">
        {switches.map((s) => (
          <SwitchCard key={s.key} s={s} />
        ))}
      </ul>
    );

  return (
    <>
      <PageHeader title={t('partner.controls.title')} sub={t('partner.controls.sub')} />
      <section className="mb-6" data-testid="partner-controls-switches">
        <h2 className="text-[18px] font-semibold text-ds-ink">{t('partner.controls.switches.title')}</h2>
        <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.controls.switches.sub')}</p>
        {switchBody}
      </section>

      <Card as="section" className="mb-6 p-5 sm:p-6">
        <div data-testid="partner-controls-capabilities">
          <h2 className="text-[18px] font-semibold text-ds-ink">{t('partner.controls.optin.title')}</h2>
          <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.controls.optin.sub')}</p>
          {!caps ? (
            <Unavailable messageKey="partner.controls.optin.unavailable" />
          ) : (
            <>
              {!caps.certified ? <p className="mt-2 text-[14px] font-semibold text-ds-ink">{t('partner.controls.optin.uncertifiedNote')}</p> : null}
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-[14px]">
                  <thead>
                    <tr className="text-ds-ink-muted">
                      <th scope="col" className="py-2 pr-4 font-semibold">{t('partner.controls.optin.feature')}</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">{t('partner.controls.optin.counsel')}</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">{t('partner.controls.optin.approval')}</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">{t('partner.controls.optin.state')}</th>
                      <th scope="col" className="py-2 font-semibold">
                        <span className="sr-only">{t('partner.controls.optin.approve')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {caps.rows.map((r) => (
                      <tr key={r.cap} data-capability={r.cap} className="border-t border-ds-border align-top">
                        <td className="py-2 pr-4 text-ds-ink">{t(CAP_LABEL[r.cap])}</td>
                        <td className="py-2 pr-4">{t(r.counsel ? 'partner.controls.optin.yes' : 'partner.controls.optin.no')}</td>
                        <td className="py-2 pr-4">
                          {r.approved ? t('partner.controls.optin.approvedBy', { who: r.approvedBy ?? '', date: day(r.approvedAt) }) : t('partner.controls.optin.no')}
                        </td>
                        <td className="py-2 pr-4">
                          <Badge tone={r.open ? 'success' : 'neutral'}>{t(r.open ? 'partner.controls.optin.open' : 'partner.controls.optin.closed')}</Badge>
                        </td>
                        <td className="py-2">
                          {r.canApprove ? <CapabilityForm capability={r.cap} on /> : null}
                          {r.canWithdraw ? <CapabilityForm capability={r.cap} on={false} /> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </Card>

      <Card as="section" className="p-5 sm:p-6">
        <div data-testid="partner-controls-readiness">
          <h2 className="text-[18px] font-semibold text-ds-ink">{t('partner.live.readiness.title')}</h2>
          <p className="mt-1 text-[14px] leading-relaxed text-ds-ink-muted">{t('partner.live.readiness.sub')}</p>
          {!readiness ? (
            <Unavailable messageKey="partner.live.readiness.unavailable" />
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {readiness.lines.map((l) => (
                <li key={l.id} data-line={l.id} data-state={l.state} className="flex flex-wrap items-center justify-between gap-2 text-[14px] text-ds-ink">
                  <span>{t(`partner.live.readiness.${l.id}` as MessageKey)}</span>
                  <Badge tone={l.state === 'pass' ? 'success' : l.state === 'fail' ? 'warning' : 'neutral'}>{t(STATE_LABEL[l.state])}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </>
  );
}
