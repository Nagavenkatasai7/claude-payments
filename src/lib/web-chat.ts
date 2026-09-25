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
import { getDb } from '@/db/client';
import { CARD_MARKER, createConversationLogRepo, type ConversationLogRepo } from '@/db/repos/conversation-log-repo';

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

export type WebChatDeps = Omit<AgentDeps, 'channel' | 'waCreds' | 'partnerId'> & {
  /**
   * Partner-Demo R3b: the sealed, permanent conversation log. Production wires
   * the Neon repo (runWebChatTurn); a test that omits it logs nothing.
   */
  conversationLog?: Pick<ConversationLogRepo, 'append'>;
};

/**
 * Build the web-channel chat over injected deps (tests bind PGlite/fakeRedis;
 * production uses runWebChatTurn below). isNewConversation is derived from web
 * thread emptiness — there is no 24h-gap heuristic and no buttonTap on web.
 * The agent runs under the PORTAL customer's tenant (fix 1): the session
 * resolved exactly one (partnerId, phone) row, and that is the tenant whose
 * ledger, recipients and counters the tools may read.
 */
export function createWebChat(deps: WebChatDeps) {
  const { conversationLog, ...agentDeps } = deps;
  const store = webThreadStore(agentDeps.store);
  return {
    async runTurn(customer: Customer, text: string): Promise<string> {
      const agent = createAgent({ ...agentDeps, store, channel: 'web', partnerId: customer.partnerId });
      const phone = customer.senderPhone;
      // R3b: the portal customer's own (tenant, phone) thread, web channel.
      // Inbound BEFORE the agent runs, the reply after it (random ids: the web
      // route does not retry a turn). A DB error fails the turn, never silently.
      const entry = { partnerId: customer.partnerId, phone, channel: 'web' } as const;
      await conversationLog?.append({ ...entry, direction: 'in', text });
      const isNewConversation = (await store.getConversation(customer.partnerId, phone)).length === 0;
      const reply = await agent.runAgentTurn(phone, text, { isNewConversation });
      await conversationLog?.append({ ...entry, direction: 'out', text: reply.trim() ? reply : CARD_MARKER });
      return reply;
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
    conversationLog: createConversationLogRepo(getDb()),
  });
  return webChat.runTurn(customer, text);
}
