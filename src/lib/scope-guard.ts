import { anyOf, normalizeChatText, rx } from './chat-text-match';
import type { NoticeLang } from './ai-notice';

/**
 * scope-guard (R56) — keeps the bot to sending money.
 *
 * classifyOffTopic is the agent.turn router's conservative pre-model check: it
 * declines a CLEARLY unrelated request (code, homework, essays and poems,
 * medical questions, trivia, jokes, recipes, role-play and rule-override
 * attempts) with one fixed reply. It never blocks a message that mentions
 * money, a transfer, its status, the account, support or a person, nor a
 * greeting: those reach the model, which declines what this check misses with
 * the decline_off_topic tool (tools.ts) and the prompt's SCOPE section.
 * Over-blocking a customer is worse than letting the model decline. Pure.
 */

/** Anything on topic, a greeting or a money figure: the message goes to the model. */
const ON_TOPIC = anyOf(
  // money, sending and the account
  /\b(?:money|send|sending|sent|transfer|transfers|transferred|remit|remittance|pay|paying|payment|payments|paid|quote|rate|rates|exchange|fee|fees|charge|charged|recipient|recipients|bank|account|upi|ifsc|deposit|refund|cancel|amount|cash|wallet|dollar|dollars|rupee|rupees|usd|inr|mxn|peso|pesos|limit|limits|verify|verification|kyc|identity|bill|invoice|schedule|recurring)\b/u,
  // a transfer's status
  /\b(?:status|arrive|arrived|arrives|deliver|delivered|delivery|receive|received|track|tracking|pending)\b/u,
  // support and a person
  /\b(?:help|support|person|human|agent|complaint|case|ticket|problem|issue|someone|real)\b/u,
  // greetings and thanks
  /^(?:hi|hello|hey|hii|good morning|good evening|thanks|thank you|namaste|namaskar|hola|gracias|buenos dias|buenos días|ok|okay)\b/u,
  // Hinglish and Spanish money words
  /\b(?:paise|paisa|bhejna|bhejne|bhejo|bheja|rupaye|khata|dinero|enviar|envío|envio|pago|transferencia|tasa|comisión|comision|cuenta|ayuda|persona)\b/u,
);
const HAS_MONEY_FIGURE = /[$₹€£]|\d+\s*(?:dollars?|rupees?|rs|usd|inr|mxn|pesos?)\b/iu;

const OFF_TOPIC = anyOf(
  // code
  /\b(?:write|create|generate|make|build|debug|fix|give me)\b(?:\s+\S+){0,4}?\s+(?:code|script|program|function|regex|sql|html|css|app|website)\b/u,
  /\b(?:python|javascript|typescript|java|golang|php|ruby|kotlin|swift|c\+\+)\b(?:\s+\S+){0,4}?\s+(?:script|code|program|function|bug|error)\b/u,
  /\b(?:code|script|program|function)\b(?:\s+\S+){0,2}?\s+in\s+(?:python|javascript|typescript|java|golang|php|ruby|kotlin|swift)\b/u,
  // writing for the customer
  /\bwrite\b(?:\s+\S+){0,3}?\s+(?:essay|poem|story|song|lyrics|novel|speech|cover letter|resume|cv|tweet|blog|article)\b/u,
  // health
  /\b(?:cure|cures|treatment|symptoms?|diagnosis|medicine|medication|dosage|side effects?)\s+(?:for|of)\b/u,
  /\bis it safe to take\b/u,
  // trivia, jokes and the like
  /\btell me a (?:joke|story|riddle|fun fact)\b/u,
  /\bwho (?:won|is the (?:president|prime minister|king|queen))\b/u,
  /\bwhat is the capital of\b/u,
  /\brecipes? (?:for|of)\b/u,
  /\bweather\b/u,
  /\bhoroscope\b/u,
  /\bmeaning of life\b/u,
  /\bplay a game\b/u,
  // homework
  /\bsolve\b(?:\s+\S+){0,2}?\s+(?:equation|math|maths|integral)\b/u,
  /\bhomework\b/u,
  // role-play and rule overrides
  /\bignore\b(?:\s+\S+){0,3}?\s+(?:previous|prior|above|earlier|your)\s+(?:instructions?|rules?|prompts?)\b/u,
  /\bpretend (?:you are|you're|to be)\b/u,
  /\b(?:roleplay|role play)\b/u,
  /\byou are now\b/u,
  // Hinglish and Spanish
  /\b(?:kavita|kahani|nibandh|chutkula|gaana)\b(?:\s+\S+){0,2}?\s*(?:likh|likho|sunao|suna|batao)\w*/u,
  /\b(?:escríbeme|escribeme|escribe|escribir|cuéntame|cuentame)\b(?:\s+\S+){0,3}?\s+(?:poema|cuento|chiste|ensayo|canción|cancion|historia|código|codigo)\b/u,
);
// The raw text, before normalization strips the backticks.
const CODE_FENCE = rx(/```/u);

/** Whether a customer message is clearly not about sending money (the fixed decline answers it). Never throws. */
export function classifyOffTopic(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = normalizeChatText(text);
  if (t === '') return false;
  if (HAS_MONEY_FIGURE.test(text) || ON_TOPIC(t)) return false;
  return CODE_FENCE.test(text) || OFF_TOPIC(t);
}

const OFF_TOPIC_REPLIES: Record<NoticeLang, string> = {
  en: 'I can only help with sending money: quotes, recipients, the status of a transfer, your account, and reaching a person. How can I help with one of those?',
  hinglish:
    'Main sirf paise bhejne mein madad kar sakta hoon: quote, recipient, transfer ka status, aapka account, aur kisi vyakti se baat. Inmein se kis cheez mein madad karoon?',
  es: 'Solo puedo ayudarle a enviar dinero: cotizaciones, destinatarios, el estado de una transferencia, su cuenta y hablar con una persona. ¿En cuál de estas cosas le ayudo?',
};

/** The fixed decline, in the customer's language. */
export function offTopicReply(lang: NoticeLang): string {
  return OFF_TOPIC_REPLIES[lang] ?? OFF_TOPIC_REPLIES.en;
}

/** The English decline (the decline_off_topic tool's reply_to_customer). */
export const OFF_TOPIC_REPLY = OFF_TOPIC_REPLIES.en;
