import { classifyHelpIntent, helpIntentSkipsModel, type HelpIntentMatch } from './help-intents';
import { classifyOffTopic } from './scope-guard';
import { detectReplyLang, type NoticeLang } from './ai-notice';
import { HELP_CASE_REPLIES } from './hold-replies';

/**
 * turn-router (PR1) — the ONE ordered decision every chat turn takes before the
 * model, after a voice note is transcribed. The WhatsApp and Telegram worker
 * (outbox-worker.ts agent.turn) and the web chat (web-chat.ts) both act on it,
 * and every route's reply goes through the same notice-adding send.
 *
 *  1. paused   — R26's slot: the tenant paused its AI agent, so the customer
 *                gets a fixed, non-AI menu. HELP still reaches a person while
 *                paused (R43: a path to a person is always on).
 *  2. help     — R43: HELP, a request for a person, a complaint, a missing or
 *                wrong payment, or a payment the customer did not make. A case
 *                is opened and a fixed reply sent, without the model.
 *  3. off_topic — R56: a clearly unrelated request gets the fixed decline.
 *  4. model    — everything else. A short cancel request is flagged (`cancel`),
 *                so the caller records a cancel case, and still reaches the
 *                model, which runs the cancel itself (owner decision Q-R43.1).
 *
 * A button tap's text is synthesized by our code, so it always goes to the
 * model (or the paused menu). Pure; never throws.
 */

export type TurnRoute =
  | { kind: 'paused' }
  | { kind: 'help'; match: HelpIntentMatch }
  | { kind: 'off_topic'; lang: NoticeLang }
  | { kind: 'model'; cancel: HelpIntentMatch | null };

export interface RouteTurnInput {
  /** The customer's text (a voice note's transcript). */
  text: unknown;
  /** The text was synthesized from a button tap. */
  isButtonTap?: boolean;
  /** R26: the tenant's AI agent is paused. */
  paused?: boolean;
}

export function routeTurn(input: RouteTurnInput): TurnRoute {
  const tap = input.isButtonTap === true;
  const intent = tap ? null : classifyHelpIntent(input.text);
  const help = intent && helpIntentSkipsModel(intent.intent) ? intent : null;
  if (help) return { kind: 'help', match: help };
  if (input.paused === true) return { kind: 'paused' };
  if (!tap && classifyOffTopic(input.text)) return { kind: 'off_topic', lang: detectReplyLang(input.text) };
  return { kind: 'model', cancel: intent?.intent === 'cancel' ? intent : null };
}

/** The fixed, non-AI answer while the agent is paused. */
export function pausedReply(lang: NoticeLang): string {
  return (HELP_CASE_REPLIES[lang] ?? HELP_CASE_REPLIES.en).agent_paused;
}
