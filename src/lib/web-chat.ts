import { createAgent, type AgentDeps } from './agent';
import { chat } from './llm';
import { raiseLlmDownAlert } from './llm-alert';
import { env } from './env';
import { getStore, type Store } from './store';
import { getCustomerStore } from './customer-store';
import { getScheduleStore } from './schedule-store';
import { getDraftStore } from './draft-store';
import { getDailyVolumeStore } from './daily-volume-store';
import { getMonthlyVolumeStore } from './monthly-volume-store';
import { getKycProvider } from './providers/kyc-provider';
import { getPartnerStore } from './partner-store';
import type { Customer, PartnerId } from './types';
import type { WebStepUp } from './tools';
import { getDb, type Db } from '@/db/client';
import { CARD_MARKER, createConversationLogRepo, type ConversationLogRepo } from '@/db/repos/conversation-log-repo';
import { pokeWorker } from './outbox';
import { routeTurn, pausedReply } from './turn-router';
import { cancelCaseWanted, openHelpCase, openHelpCaseAndPoke } from './help-case';
import { helpCaseReasonFor, helpIntentReply, helpReplyLang } from './help-intents';
import { offTopicReply } from './scope-guard';
import { aiNoticeText, detectReplyLang, withAiNotice, type NoticeLang } from './ai-notice';
import { aiNoticeDueFor, recordAiNotice } from './ai-notice-marker';
import { logWarn } from './log';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { replyGuardAlertFor, type ReplyGuardReport } from './reply-guard';
import { redactSensitive, redactionNotice } from './inbound-redact';
import { composeReply } from './compose-reply';

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

export type WebChatDeps = Omit<AgentDeps, 'channel' | 'waCreds' | 'partnerId' | 'onFallback' | 'onReplyGuard'> & {
  /**
   * Partner-Demo R3b: the sealed, permanent conversation log. REQUIRED, so a
   * caller cannot silently skip logging; production wires the Neon repo
   * (runWebChatTurn).
   */
  conversationLog: Pick<ConversationLogRepo, 'append'>;
  /**
   * Raises the deduped llmdown ops alert for a fallback's cause (a no-op unless
   * it is a permanent provider error; never throws, bounded). Default
   * raiseLlmDownAlert; tests inject a spy.
   */
  alertLlmDown?: (err: unknown) => Promise<void>;
  /**
   * PR1: the database the router writes to (a help case, the AI-notice marker).
   * Default getDb(); tests bind PGlite.
   */
  db?: Db;
  /** R26's slot: whether this tenant's AI agent is paused (see WorkerDeps.agentPaused). Absent ⇒ never. */
  agentPaused?: (partnerId: PartnerId) => Promise<boolean>;
};

/**
 * Per-turn options. The customer portal chat passes its session's step-up state
 * (webStepUp); the legacy /api/account/chat passes nothing (unchanged behaviour).
 */
export type WebChatTurnOptions = { webStepUp?: WebStepUp };

/**
 * Build the web-channel chat over injected deps (tests bind PGlite/fakeRedis;
 * production uses runWebChatTurn below). isNewConversation is derived from web
 * thread emptiness — there is no 24h-gap heuristic and no buttonTap on web.
 * The agent runs under the PORTAL customer's tenant (fix 1): the session
 * resolved exactly one (partnerId, phone) row, and that is the tenant whose
 * ledger, recipients and counters the tools may read.
 */
export function createWebChat(deps: WebChatDeps) {
  const { conversationLog, alertLlmDown = raiseLlmDownAlert, db: dbDep, agentPaused, ...agentDeps } = deps;
  const store = webThreadStore(agentDeps.store);
  return {
    async runTurn(customer: Customer, rawText: string, opts?: WebChatTurnOptions): Promise<string> {
      const db = dbDep ?? getDb();
      // R49: card, account, routing, IFSC, SSN, PAN, Aadhaar and IBAN numbers are
      // hidden first, so the sealed log, the Redis thread and the model only see
      // the label; the reply then leads with the redaction notice.
      const red = redactSensitive(rawText);
      const text = red.text;
      const redacted = red.kinds.length > 0;
      const partnerId = customer.partnerId;
      const phone = customer.senderPhone;
      // R3b: the portal customer's own (tenant, phone) thread, web channel.
      // Inbound BEFORE the agent runs, the reply after it (random ids: the web
      // route does not retry a turn). A DB error fails the turn, never silently.
      const entry = { partnerId, phone, channel: 'web' } as const;
      await conversationLog.append({ ...entry, direction: 'in', text });

      // PR1: the same ordered router as the WhatsApp worker (turn-router.ts):
      // R26's paused slot, HELP (R43), off-topic (R56), then the model. The AI
      // notice (R17) leads the reply when the durable web marker says it is due;
      // the marker is written in the same transaction as a help case.
      const noticeDue = await aiNoticeDueFor(db, partnerId, phone, 'web');
      const route = routeTurn({ text, paused: agentPaused ? await agentPaused(partnerId) : false });
      const lang = detectReplyLang(text);
      // The web reply is the HTTP answer, not an outbox row: it is logged, then
      // the marker is written. A failed marker write never loses the reply; the
      // next reply simply shows the notice again (fail safe).
      const finish = async (body: string, noticeLang: NoticeLang): Promise<string> => {
        const notice = noticeDue ? aiNoticeText(noticeLang, 'web') : '';
        const led = redacted ? composeReply({ redactionNotice: redactionNotice(noticeLang), modelText: body }) : body;
        const reply = withAiNotice(led, notice);
        await conversationLog.append({ ...entry, direction: 'out', text: reply.trim() ? reply : CARD_MARKER });
        if (notice) {
          try {
            await recordAiNotice(db, { partnerId, phone, surface: 'web', channel: 'web', lang: noticeLang });
          } catch (err) {
            logWarn('ai.notice', 'web notice marker write failed: the notice shows again next time', { error: err instanceof Error ? err.name : 'error' });
          }
        }
        return reply;
      };

      if (route.kind === 'help') {
        // R43: the case, its triage row and the deduped ops alert commit together.
        const match = route.match;
        const body = await db.transaction(async (tx) => {
          const helpCase = await openHelpCase(tx, { partnerId, phone, reason: helpCaseReasonFor(match.intent), channel: 'web', source: 'keyword' });
          return helpIntentReply(match, { caseId: helpCase.caseId, channel: 'web' });
        });
        pokeWorker(); // after the commit: triage and the ops alert go out now
        return finish(body, helpReplyLang(match.lang));
      }
      if (route.kind === 'paused') return finish(pausedReply(lang), lang);
      if (route.kind === 'off_topic') return finish(offTopicReply(route.lang), route.lang);
      // Owner decision Q-R43.1: a cancel request with a paid or held transfer
      // records a cancel case; the model still answers it.
      if (route.cancel && (await cancelCaseWanted(db, partnerId, phone))) {
        await openHelpCaseAndPoke(db, { partnerId, phone, reason: 'cancel_request', channel: 'web', source: 'keyword' });
      }

      let fallbackErr: unknown;
      let guard: ReplyGuardReport | undefined;
      const agent = createAgent({
        ...agentDeps,
        onFallback: (e) => {
          fallbackErr = e;
        },
        onReplyGuard: (r) => {
          guard = r;
        },
        store,
        channel: 'web',
        partnerId,
        ...(opts?.webStepUp ? { webStepUp: opts.webStepUp } : {}),
      });
      const isNewConversation = (await store.getConversation(partnerId, phone)).length === 0;
      const reply = await agent.runAgentTurn(phone, text, { isNewConversation });
      // Same llmdown key as the WhatsApp worker, so one outage hour is one alert.
      if (fallbackErr !== undefined) await alertLlmDown(fallbackErr);
      const out = await finish(reply, lang);
      // R32: the same deduped replyguard alert as the worker (kinds and mode
      // only). The web reply is the HTTP answer, not an outbox row, so the
      // alert is written after it is logged; a failed write never loses it.
      if (guard) {
        try {
          const alert = replyGuardAlertFor({ tenant: partnerId, where: 'web chat', report: guard, hour: Math.floor(Date.now() / 3_600_000) });
          await createOutboxRepo(db).enqueue('ops.alert', { message: alert.message }, { dedupeKey: alert.dedupeKey });
          pokeWorker(); // marks the alert due (the cron's Neon gate skips unmarked work)
        } catch (err) {
          logWarn('web-chat.reply-guard', 'replyguard alert enqueue failed', { error: err instanceof Error ? err.name : 'error' });
        }
      }
      return out;
    },
  };
}

/** Production entry: one authenticated web chat turn for this customer. */
export async function runWebChatTurn(customer: Customer, text: string, opts?: WebChatTurnOptions): Promise<string> {
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
  return webChat.runTurn(customer, text, opts);
}
