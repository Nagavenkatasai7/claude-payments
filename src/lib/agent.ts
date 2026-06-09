import { buildSystemPrompt } from './prompt';
import { toolSchemas, executeTool } from './tools';
import type { ChatMessage, ChatTool, TurnContext } from './types';
import type { Store } from './store';
import type { ScheduleStore } from './schedule-store';
import type { DraftStore } from './draft-store';
import type { CustomerStore } from './customer-store';
import type { DailyVolumeStore } from './daily-volume-store';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { KycProvider } from './providers/kyc-provider';
import type { PartnerStore } from './partner-store';
import { allowedSendCurrencies, currencyForPhone } from './partner-currency';
import { getRecentTransfersNote } from './recent-transfers'; // NEW (transfer-memory)
import { normalizePhone } from './phone';
import { getSenderDefaultsNote } from './sender-defaults'; // NEW (Bundle C)
import { isSendVerified, sendGateActive } from './kyc-gate';
import { resolvePartnerBranding } from './partner-config';
import { looksLikeVerifyHandoff, issueVerifyLink } from './verify-link';

const MAX_TOOL_ROUNDS = 6;
const FALLBACK_REPLY =
  "Sorry, I'm having trouble right now. Could you send that again?";

export interface AgentDeps {
  chat: (messages: ChatMessage[], tools: ChatTool[]) => Promise<ChatMessage>;
  store: Store;
  scheduleStore: ScheduleStore;
  draftStore: DraftStore;
  customerStore: CustomerStore;
  dailyVolumeStore: DailyVolumeStore;
  monthlyVolumeStore: MonthlyVolumeStore;  // NEW (KYC)
  kycProvider: KycProvider;
  partnerStore: PartnerStore; // NEW (P4)
}

/**
 * Strip every URL the model wrote and optionally append the canonical,
 * code-generated payment link verbatim.
 *
 * The AI model must NEVER be trusted to emit a URL — it can mistype the
 * domain (typo-squatting risk). All payment links come from our code only.
 */
export function sanitizeReply(reply: string, paymentLinks: string[]): string {
  // Strip every URL the model wrote — the model must never emit links itself.
  const stripped = reply
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n/g, '\n')
    .trim();
  if (paymentLinks.length === 0) return stripped;
  // Append the canonical, code-generated link verbatim.
  const link = paymentLinks[paymentLinks.length - 1];
  return `${stripped}\n\n${link}`.trim();
}

export function createAgent(deps: AgentDeps) {
  // One retry on a transient chat() failure (Ollama Cloud 5xx / timeout / a
  // momentarily malformed response). A throw means history.push(assistant) never
  // ran, so the retry re-sends the identical messages cleanly.
  async function chatWithRetry(
    messages: ChatMessage[],
    tools: ChatTool[],
  ): Promise<ChatMessage> {
    try {
      return await deps.chat(messages, tools);
    } catch (err) {
      console.warn('chat() failed once — retrying:', err);
      return await deps.chat(messages, tools);
    }
  }

  async function runAgentTurn(
    phone: string,
    incomingText: string,
    turn: TurnContext = { isNewConversation: false },
  ): Promise<string> {
    const history = await deps.store.getConversation(phone);
    history.push({ role: 'user', content: incomingText });

    // A throw anywhere below (Ollama after its retry, a Redis blip mid-turn, …)
    // would otherwise surface the route's bare "something went wrong" catch-all
    // AND drop the turn. Degrade to a friendly retry line and PRESERVE history
    // (the inbound message + any partial turns) so the customer can just resend.
    try {
      return await completeTurn(phone, turn, history);
    } catch (err) {
      console.error('runAgentTurn failed — returning fallback:', err);
      try {
        await deps.store.saveConversation(phone, history);
      } catch (saveErr) {
        console.error('saveConversation after failure also failed:', saveErr);
      }
      return FALLBACK_REPLY;
    }
  }

  async function completeTurn(
    phone: string,
    turn: TurnContext,
    history: ChatMessage[],
  ): Promise<string> {
    // Resolve the partner's allowed send currencies ONCE before the round loop.
    // Use distinct names (noteCustomer / notePartner) to avoid shadowing any
    // variables introduced by tool calls later in the same scope.
    const noteCustomer = await deps.customerStore.getCustomer(phone);
    const notePartner = noteCustomer
      ? (await deps.partnerStore.getPartner(noteCustomer.partnerId)) ?? (await deps.partnerStore.ensureDefaultPartner())
      : await deps.partnerStore.ensureDefaultPartner();
    const sendCurrencies = allowedSendCurrencies(notePartner);

    // WL1 white-label: resolve the partner's brand + KYC posture ONCE. The
    // default/unconfigured partner ⇒ brand 'SmartRemit', persona '', gate ON —
    // identical to today (buildSystemPrompt({brand:'SmartRemit',botPersona:''})
    // === the original SYSTEM_PROMPT). A 'delegated' partner runs KYC on their
    // side, so we suppress every verify-leading note + the verify backstop.
    // (Sanctions are unaffected and still run inside createTransfer.)
    const branding = resolvePartnerBranding(notePartner);
    const gateActive = sendGateActive(notePartner);

    // Recent-transfer memory: the customer's OWN recent sends, surfaced once at
    // round 0 so the model can reference "you sent Mom $500 yesterday". '' when
    // the customer has no history ⇒ nothing is injected (behavior unchanged).
    const recentNote = await getRecentTransfersNote(phone, deps.store);

    // Sticky funding default (Bundle C): surfaced once at round 0 so the bot can
    // default the funding method instead of re-asking. '' (no injection) for new /
    // history-less customers and stale defaults — behavior unchanged.
    const senderDefaultsNote = getSenderDefaultsNote(noteCustomer);

    let reply = '';
    // When a tool has already sent an interactive message (recipient picker or the
    // Approve & Pay card), that card IS the reply — we suppress the model's trailing
    // text so the customer never gets a redundant second "here's your quote" message.
    let interactiveSent = false;
    const paymentLinks: string[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // A one-off system note for new conversations. Not persisted to history
      // (only injected into the messages sent to the model this turn) so it
      // doesn't echo on every later turn.
      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt({ brand: branding.brand, botPersona: branding.botPersona }) },
      ];
      if (turn.isNewConversation && round === 0) {
        messages.push({
          role: 'system',
          content:
            '[NEW CONVERSATION] First message in over 24 hours. Greet warmly and ask how you can help (you may reference their recent history if shown). Do NOT call list_saved_recipients or send_recipient_picker yet — wait until the user actually wants to send. Only then offer a picker or take their details.',
        });
      }
      // Recipient button tap: freeze the chosen recipient's full details server-side
      // so the model proceeds straight to amount + funding and NEVER re-asks who.
      if (round === 0 && turn.buttonTap?.kind === 'recipient') {
        try {
          const norm = normalizePhone(turn.buttonTap.recipientPhone);
          const found = (await deps.store.listRecipients(phone, 25)).find(
            (r) => normalizePhone(r.recipientPhone) === norm,
          );
          if (found) {
            messages.push({
              role: 'system',
              content:
                `[RECIPIENT SELECTED] name=${found.name}, recipient_phone=${found.recipientPhone}, ` +
                `payout_method=${found.payoutMethod}, payout_destination=${found.payoutDestination}. ` +
                'You already have the recipient — do NOT call send_recipient_picker or ask who again. ' +
                'Just collect the amount and funding method, then send_approve_picker.',
            });
          }
        } catch (err) {
          console.warn('recipient-tap hydration failed:', err);
        }
      }
      // These two notes LEAD with verify-before-send; only inject them when our
      // KYC gate is active. A 'delegated' partner (gateActive=false) handles KYC
      // on their side, so a brand-new customer just gets the normal warm greeting.
      if (round === 0 && gateActive) {
        if (turn.isNewCustomer) {
          messages.push({
            role: 'system',
            content:
              '[NEW CUSTOMER] This is the first message ever from this phone. Greet warmly, explain they must verify their identity before their first send, call check_send_limit({amount_usd: 0}) to fetch the kyc_url, and share that URL asking them to verify first. You may mention they can send up to $500/day for their first 3 days once verified. Do NOT ask how much they want to send until they are verified.',
          });
        } else if (turn.tierReminderDayOfWindow) {
          messages.push({
            role: 'system',
            content:
              `[TIER_REMINDER day ${turn.tierReminderDayOfWindow}/3] T0 customer in their observation window. Briefly remind them which day they're on and share the kyc_url (from check_send_limit({amount_usd: 0})) before continuing the normal flow.`,
          });
        }
      }
      if (round === 0 && sendCurrencies.length > 1) {
        const detected = currencyForPhone(phone) ?? sendCurrencies[0];
        messages.push({
          role: 'system',
          content:
            `[SEND CURRENCIES: ${sendCurrencies.join(', ')}. The sender sends in ${detected} ` +
            `(auto-detected from their number) — do NOT ask which currency; the tools default to it. ` +
            `Pass source_currency ONLY if the sender explicitly asks for a different listed currency.]`,
        });
      }
      if (round === 0 && recentNote) {
        messages.push({ role: 'system', content: recentNote });
      }
      if (round === 0 && senderDefaultsNote) {
        messages.push({ role: 'system', content: senderDefaultsNote });
      }
      // Deterministic verify-before-send guard. The hard gate is enforced at the
      // tool level (every quote/transfer re-checks isSendVerified), but the model
      // must ALSO lead the conversation with verification instead of collecting an
      // amount — otherwise an unverified sender gets "how much?" before being asked
      // to verify. Server-injected so it never depends on the model reading prompt.ts.
      if (round === 0 && gateActive && !isSendVerified(noteCustomer)) {
        messages.push({
          role: 'system',
          content:
            '[UNVERIFIED SENDER] This customer is NOT identity-verified, so they cannot send money yet — ' +
            'every quote and transfer is blocked at the tool level until they verify. If they signal any ' +
            'intent to send (even before naming an amount), do NOT ask "how much", do NOT call get_quote ' +
            'or send_approve_picker, and do NOT collect recipient/payment details. Instead call ' +
            'check_send_limit({amount_usd: 0}) for the kyc_url and ask them to verify first, sharing the link. ' +
            'Do not claim their verification is complete or in progress — just ask them to finish verifying.',
        });
      }
      messages.push(...history);

      const assistant = await chatWithRetry(messages, toolSchemas);
      history.push(assistant);

      if (assistant.tool_calls && assistant.tool_calls.length > 0) {
        for (const call of assistant.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            args = {};
          }
          // Crash-safety: a single tool throwing must NOT crash the whole turn
          // (which would surface the generic "something went wrong" to the user).
          // Catch any throw and hand the model an { error } it can recover from.
          let result: Record<string, unknown>;
          try {
            result = await executeTool(call.function.name, args, {
              phone,
              store: deps.store,
              scheduleStore: deps.scheduleStore,
              draftStore: deps.draftStore,
              customerStore: deps.customerStore,
              dailyVolumeStore: deps.dailyVolumeStore,
              monthlyVolumeStore: deps.monthlyVolumeStore,  // NEW (KYC)
              kycProvider: deps.kycProvider,
              partnerStore: deps.partnerStore, // NEW (P4)
              turn,
            });
          } catch (err) {
            console.error(`tool ${call.function.name} threw:`, err);
            result = { error: 'That step hit a temporary snag — apologize briefly and ask the user to try again.' };
          }
          // An interactive (picker/approve card) sent by a tool IS the reply.
          if ((result as Record<string, unknown>).sent === true) interactiveSent = true;
          // Collect canonical payment links generated by our code.
          if (
            call.function.name === 'generate_payment_link' &&
            typeof (result as Record<string, unknown>).url === 'string'
          ) {
            paymentLinks.push((result as Record<string, unknown>).url as string);
          }
          // Collect the canonical VERIFY link from ANY tool that returns a kyc_url
          // (the verify-before-send gate + the cap hand-offs). sanitizeReply strips
          // every model-emitted URL, so the real, code-generated link must be
          // appended by us — otherwise a verify message arrives as a 👉 with no link.
          if (typeof (result as Record<string, unknown>).kyc_url === 'string') {
            paymentLinks.push((result as Record<string, unknown>).kyc_url as string);
          }
          history.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
        continue;
      }

      reply = assistant.content || '';
      break;
    }

    // Deterministic verify-link backstop. The model is NOT trusted to deliver the
    // verify link: on "resend the verify link" it often echoes a URL from history
    // with NO tool call, which sanitizeReply then strips → a 👉 with no link. If
    // the customer still needs KYC, no tool minted a link this turn, and the reply
    // reads as a verify hand-off, we mint the canonical (code-generated) link here
    // and append it via the same paymentLinks path — independent of any tool call.
    if (
      !interactiveSent &&
      paymentLinks.length === 0 &&
      gateActive &&
      !isSendVerified(noteCustomer) &&
      looksLikeVerifyHandoff(reply)
    ) {
      const url = await issueVerifyLink({
        phone,
        customer: noteCustomer,
        kycProvider: deps.kycProvider,
        customerStore: deps.customerStore,
      });
      if (url) paymentLinks.push(url);
    }

    // If a tool already sent an interactive message this turn, that card IS the
    // reply — return '' so the webhook sends no redundant trailing text. Otherwise
    // an empty reply means something genuinely went wrong → the fallback line.
    if (interactiveSent) {
      await deps.store.saveConversation(phone, history);
      return '';
    }
    if (!reply) reply = FALLBACK_REPLY;
    // Sanitize: strip model-emitted URLs, append canonical link if present.
    reply = sanitizeReply(reply, paymentLinks);
    await deps.store.saveConversation(phone, history);
    return reply;
  }

  return { runAgentTurn };
}
