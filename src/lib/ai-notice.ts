import { boundUntrustedText } from './untrusted-text';

/**
 * ai-notice (R17) — the fixed notice that the customer is talking to an AI.
 *
 * The agent.turn router's sendReply (outbox-worker.ts) and the web chat
 * (web-chat.ts) put it at the top of the first reply of a conversation and
 * again once 24 hours have passed since the last one, from a DURABLE marker
 * (ai-notice-marker.ts: an audit_events row written in the reply's own
 * transaction). Every reply path carries it: the model's answer, a card-only
 * turn (a notice-only message), the HELP case reply, the off-topic decline, the
 * busy fallback and a voice-note failure.
 *
 * Policy, not a setting (Anthropic usage policy for consumer chat): there is no
 * switch. The text names no partner. The licensed-provider line is a parameter
 * that stays empty until PR4 builds it.
 *
 * Pure: no I/O.
 */

/** The wording version the owner and counsel approve. Bump it on any text change. */
export const AI_NOTICE_VERSION = '2026-10-31.1 (draft, awaiting owner and counsel approval)';
/** The notice comes back once this long has passed since the last one. */
export const AI_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type NoticeLang = 'en' | 'hinglish' | 'es';
export type AiNoticeChannel = 'whatsapp' | 'telegram' | 'voice' | 'web';

const NOTICES: Record<NoticeLang, { lead: string; voice: string; reply: string; type: string }> = {
  en: {
    lead: "You're chatting with an AI assistant, not a person.",
    voice: 'Your voice notes are turned into text automatically.',
    reply: 'Reply HELP at any time to reach a person.',
    type: 'Type HELP at any time to reach a person.',
  },
  hinglish: {
    lead: 'Aap ek AI assistant se baat kar rahe hain, kisi insaan se nahi.',
    voice: 'Aapke voice note apne aap text mein badle jaate hain.',
    reply: 'Kisi vyakti se baat karne ke liye kabhi bhi HELP likhein.',
    type: 'Kisi vyakti se baat karne ke liye kabhi bhi HELP likhein.',
  },
  es: {
    lead: 'Está hablando con un asistente de IA (inteligencia artificial), no con una persona.',
    voice: 'Sus notas de voz se convierten en texto automáticamente.',
    reply: 'Responda HELP en cualquier momento para hablar con una persona.',
    type: 'Escriba HELP en cualquier momento para hablar con una persona.',
  },
};

const PROVIDER_LINE_MAX = 200;

/** The notice for one language and channel, plus the licensed-provider line on its own line when given. */
export function aiNoticeText(lang: NoticeLang, channel: AiNoticeChannel, providerLine?: string): string {
  const n = NOTICES[lang] ?? NOTICES.en;
  const parts = [n.lead];
  if (channel === 'voice') parts.push(n.voice);
  parts.push(channel === 'web' ? n.type : n.reply);
  const text = parts.join(' ');
  const provider = boundUntrustedText(providerLine, PROVIDER_LINE_MAX).trim();
  return provider ? `${text}\n${provider}` : text;
}

/** The reply with the notice on top. Idempotent; an empty notice changes nothing. */
export function withAiNotice(reply: string, notice: string): string {
  if (!notice) return reply;
  if (!reply.trim()) return notice;
  if (reply.startsWith(notice)) return reply;
  return `${notice}\n\n${reply}`;
}

/** Whether the notice is due: never shown, or shown AI_NOTICE_INTERVAL_MS ago or more. */
export function aiNoticeDue(lastShownAt: Date | null, now: Date): boolean {
  if (!lastShownAt) return true;
  return now.getTime() - lastShownAt.getTime() >= AI_NOTICE_INTERVAL_MS;
}

const DEVANAGARI = /[ऀ-ॿ]/u;
const SPANISH_MARK = /[ñ¿¡]/u;
const SPANISH_WORDS = new Set([
  'hola', 'quiero', 'enviar', 'envío', 'envio', 'dinero', 'gracias', 'cuánto', 'cuanto', 'cuesta', 'necesito', 'ayuda',
  'transferencia', 'cómo', 'mamá', 'papá', 'hermano', 'hermana', 'buenos', 'buenas', 'días', 'por', 'favor', 'puedo', 'usted', 'para',
  'un', 'una', 'que', 'qué', 'el', 'los', 'las', 'del', 'mi', 'mis', 'es', 'está', 'esta', 'tengo', 'dónde', 'donde',
  'escríbeme', 'escribeme', 'escribe', 'cuéntame', 'cuentame', 'poema', 'cuento', 'chiste', 'ensayo', 'canción', 'historia',
]);
const HINGLISH_WORDS = new Set([
  'kya', 'hai', 'hain', 'mujhe', 'mera', 'meri', 'mere', 'paise', 'paisa', 'bhejna', 'bhejne', 'bhejo', 'kaise', 'nahi', 'nahin',
  'karna', 'karo', 'chahiye', 'aap', 'aapka', 'kitna', 'kitne', 'namaste', 'haan', 'kripya', 'theek', 'haal', 'bhai', 'ko',
  'ek', 'likh', 'likho', 'kavita', 'kahani', 'batao', 'sunao', 'karein', 'kar', 'mein', 'se', 'ka', 'ki',
]);

/**
 * The language a fixed text (the notice, the off-topic decline) is written in,
 * from the customer's own message. Devanagari is answered in Hinglish, as the
 * bot answers Hindi. Two clear word hits (or a Spanish-only mark) are needed;
 * anything unclear is English. Never throws.
 */
export function detectReplyLang(text: unknown): NoticeLang {
  if (typeof text !== 'string' || !text.trim()) return 'en';
  if (DEVANAGARI.test(text)) return 'hinglish';
  if (SPANISH_MARK.test(text)) return 'es';
  const words = text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);
  const es = words.filter((w) => SPANISH_WORDS.has(w)).length;
  const hl = words.filter((w) => HINGLISH_WORDS.has(w)).length;
  if (es >= 2 && es > hl) return 'es';
  if (hl >= 2 && hl > es) return 'hinglish';
  return 'en';
}
