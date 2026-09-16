import { createAgent, type AgentDeps } from './agent';
import { chat } from './ollama';
import { env } from './env';
import { getStore, type Store } from './store';
import { getCustomerStore } from './customer-store';
import { getScheduleStore } from './schedule-store';
import { getDraftStore } from './draft-store';
import { getDailyVolumeStore } from './daily-volume-store';
import { getMonthlyVolumeStore } from './monthly-volume-store';
import { getKycProvider } from './providers/kyc-provider';
import { getPartnerStore } from './partner-store';
import type { Customer } from './types';

// web-chat (B5) — the WhatsApp agent brain re-channeled into the customer web
// dashboard. The web thread is keyed `conv:<partnerId>:web:<phone>` — deliberately SEPARATE
// from the WhatsApp thread at `conv:<partnerId>:<phone>`: consent/STOP state, drafts, and
// button taps are phone-thread concepts the web surface must never touch. The
// agent runs with channel 'web', which narrows the tools to WEB_TOOL_ALLOWLIST
// at BOTH the schema and dispatch layers (see tools.ts).

/** The store key-space prefix that lands web threads at `conv:<partnerId>:web:<phone>`. */
export function webThreadPhone(phone: string): string {
  return `web:${phone}`;
}

/**
 * Wrap a Store so ONLY the conversation read/write use the web thread key
 * (`conv:<partnerId>:web:<phone>` via the store's own tenant-keyed `conv:` prefix). Everything else —
 * ledger reads, recipients, velocity — delegates unchanged, so tool ownership
 * checks still run against the REAL phone. TTL (30d) and trim-to-40 come from
 * the base saveConversation, identical to WhatsApp.
 */
export function webThreadStore(base: Store): Store {
  return {
    ...base,
    getConversation: (partnerId, phone) => base.getConversation(partnerId, webThreadPhone(phone)),
    saveConversation: (partnerId, phone, messages) =>
      base.saveConversation(partnerId, webThreadPhone(phone), messages),
  };
}

export type WebChatDeps = Omit<AgentDeps, 'channel' | 'waCreds' | 'partnerId'>;

/**
 * Build the web-channel chat over injected deps (tests bind PGlite/fakeRedis;
 * production uses runWebChatTurn below). isNewConversation is derived from web
 * thread emptiness — there is no 24h-gap heuristic and no buttonTap on web.
 * The agent runs under the PORTAL customer's tenant (fix 1): the session
 * resolved exactly one (partnerId, phone) row, and that is the tenant whose
 * ledger, recipients and counters the tools may read.
 */
export function createWebChat(deps: WebChatDeps) {
  const store = webThreadStore(deps.store);
  return {
    async runTurn(customer: Customer, text: string): Promise<string> {
      const agent = createAgent({ ...deps, store, channel: 'web', partnerId: customer.partnerId });
      const phone = customer.senderPhone;
      const isNewConversation = (await store.getConversation(customer.partnerId, phone)).length === 0;
      return agent.runAgentTurn(phone, text, { isNewConversation });
    },
  };
}

/** Production entry: one authenticated web chat turn for this customer. */
export async function runWebChatTurn(customer: Customer, text: string): Promise<string> {
  const store = getStore();
  const customerStore = getCustomerStore(store);
  const webChat = createWebChat({
    chat,
    store,
    scheduleStore: getScheduleStore(),
    draftStore: getDraftStore(),
    customerStore,
    dailyVolumeStore: getDailyVolumeStore(),
    monthlyVolumeStore: getMonthlyVolumeStore(),
    kycProvider: getKycProvider(customerStore, env.appBaseUrl),
    partnerStore: getPartnerStore(),
  });
  return webChat.runTurn(customer, text);
}
