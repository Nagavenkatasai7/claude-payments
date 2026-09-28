import type { AgentChannel, ToolContext } from './tools';
import type { PartnerId, TurnContext } from './types';
import { getStore } from './store';
import { getCustomerStore } from './customer-store';
import { getScheduleStore } from './schedule-store';
import { getDraftStore } from './draft-store';
import { getDailyVolumeStore } from './daily-volume-store';
import { getMonthlyVolumeStore } from './monthly-volume-store';
import { getKycProvider } from './providers/kyc-provider';
import { getPartnerStore } from './partner-store';
import { selectSettlementRoute } from './partner-rates'; // best-rate routing
import { getPartnerIntegrationsStore } from './partner-integrations-store';
import { getDb } from '@/db/client';
import { env } from './env';

/** The stores a tool context carries (the agent's deps, less the model client). */
export type ToolContextDeps = Pick<
  ToolContext,
  | 'store'
  | 'scheduleStore'
  | 'draftStore'
  | 'customerStore'
  | 'dailyVolumeStore'
  | 'monthlyVolumeStore'
  | 'kycProvider'
  | 'partnerStore'
  | 'waCreds'
>;

/**
 * The ONE ToolContext builder (UI redesign M2-4): the object the agent built
 * inline for every turn, moved verbatim, so the bot and a non-bot caller (the
 * customer portal) run the tools and the send seam over the same context.
 *
 * `channel` is required: the caller states which surface it is. Every absent
 * dep falls back LAZILY to the same singleton production wires (the worker's
 * createAgent deps); the agent passes all of them, so it never touches one.
 * waCreds has no default (absent ⇒ the shared env number, as before).
 */
export function buildToolContext(args: {
  partnerId: PartnerId;
  phone: string;
  channel: AgentChannel;
  turn: TurnContext;
  deps?: Partial<ToolContextDeps>;
}): ToolContext {
  const { partnerId, phone, channel, turn } = args;
  const deps = args.deps ?? {};
  const store = deps.store ?? getStore();
  const customerStore = deps.customerStore ?? getCustomerStore(store);
  return {
    phone,
    partnerId,
    store,
    scheduleStore: deps.scheduleStore ?? getScheduleStore(),
    draftStore: deps.draftStore ?? getDraftStore(),
    customerStore,
    dailyVolumeStore: deps.dailyVolumeStore ?? getDailyVolumeStore(),
    monthlyVolumeStore: deps.monthlyVolumeStore ?? getMonthlyVolumeStore(), // NEW (KYC)
    kycProvider: deps.kycProvider ?? getKycProvider(customerStore, env.appBaseUrl),
    partnerStore: deps.partnerStore ?? getPartnerStore(), // NEW (P4)
    waCreds: deps.waCreds, // WL2 — partner's outbound creds for interactive sends
    channel, // B5 — 'web' blocks non-allowlisted tools at dispatch
    turn,
    // Best-rate routing: the LIVE selection service (partner_rates +
    // integrations over the shared Pool). The tools gate by tenant
    // (default only) and fail open to mid — this only supplies it.
    routeSelector: (s, d, m) =>
      selectSettlementRoute(getDb(), getPartnerIntegrationsStore(), s, d, m),
  };
}
