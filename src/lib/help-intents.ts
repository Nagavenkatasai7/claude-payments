import { anyOf, normalizeChatText, rx } from './chat-text-match';
import { helpCaseReply, type HelpCaseReplyKind, type HelpReplyChannel, type HelpReplyLang } from './hold-replies';
import type { HelpCaseReason } from './help-case';

/**
 * help-intents (R43): the deterministic check the agent.turn router runs on a
 * customer's text BEFORE the model, so HELP and a request for a person always
 * reach a person, even when the model is down.
 *
 * Conservative by design. A match needs one of:
 *  - the whole message is a help keyword ("HELP", "मदद", "madad chahiye", "ayuda");
 *  - an explicit request for a person ("talk to a human", "agent se baat", "hablar con una persona");
 *  - a complaint, a missing or wrong payment, or a payment the customer did not make;
 *  - a short cancel request (the bot still runs; see helpIntentSkipsModel).
 * A send ("help me send 100"), a status question ("where is my money?") and a
 * question about the bot itself ("are you a human?") never match: those go to
 * the model, which must answer that it is an AI (prompt.ts RULES).
 *
 * Languages: English, Hindi in Devanagari, Hinglish (Hindi in Roman letters) and
 * Spanish. A native speaker reviews the phrase lists (non-code step).
 */

export type HelpIntent = 'help' | 'human' | 'complaint' | 'money_problem' | 'unauthorised' | 'cancel';
export type HelpLang = 'en' | 'hi' | 'hinglish' | 'es';
export interface HelpIntentMatch {
  intent: HelpIntent;
  lang: HelpLang;
}

/** Longer messages carry more than a keyword: the model reads them. */
const MAX_CLASSIFY_CHARS = 200;
/** A cancel request is a short message; anything longer is the bot's to read. */
const MAX_CANCEL_WORDS = 7;

type Rules = Partial<Record<HelpIntent, (t: string) => boolean>>;

const any = anyOf;

// ── English ──────────────────────────────────────────────────────────────────
const EN_SELF_QUESTION = rx(/^(?:are|r) (?:you|u)\b|^(?:is this|is it|am i)\b/u);
const EN_MONEY = rx(/\b(?:money|funds|amount|cash|remittance)\b/u);
const EN_PAY_WORD = rx(/\b(?:transfer|payment|deposit)\b/u);
const EN_NOT_MONEY = rx(/\b(?:link|code|otp|button|card|message|email|sms|verification|verify|receipt|notification)\b/u);
const EN_NOT_RECEIVED = rx(
  /\b(?:not received|(?:didn't|didnt|did not|haven't|havent|have not|hasn't|hasnt|has not|never) (?:receive|received|get|got|arrive|arrived|reach|reached|come|came)|not arrived|never arrived|not reached|(?:is|are|went|gone) missing|got lost|was lost|is lost)\b/u,
);
const EN: Rules = {
  unauthorised: (t) =>
    !rx(/\b(?:avoid|prevent|protect|safe from)\b/u).test(t) &&
    any(
      /\b(?:fraud|fraudulent|scam|scammed|scammer|hacked|stolen|stole|unauthori[sz]ed|identity theft)\b/u,
      /\bi (?:didn't|didnt|did not|never) (?:make|send|sent|authori[sz]e|approve|do) (?:this|that|it|the|a|any)\b/u,
      /\bsomeone (?:else )?(?:used|took|accessed|logged into|is using) my\b/u,
    )(t),
  money_problem: (t) =>
    any(
      /\b(?:wrong amount|received less|charged twice|double charged|deducted twice)\b/u,
      /\bsent (?:it |the money |money )?to the wrong (?:person|account|number|recipient)\b/u,
    )(t) || (EN_NOT_RECEIVED.test(t) && (EN_MONEY.test(t) || (EN_PAY_WORD.test(t) && !EN_NOT_MONEY.test(t)))),
  complaint: any(
    /^(?:a )?complaint$/u,
    /\b(?:file|make|lodge|raise|register|submit|open) (?:a |an |my )?(?:formal )?complaint\b/u,
    /\bi (?:want|need|would like|wish) to (?:file a |make a |lodge a |raise a )?complain\b/u,
    /\b(?:i have|this is|here is) a complaint\b/u,
  ),
  human: (t) =>
    any(
      /^(?:a )?(?:human|person|real person|live person|agent|live agent|human agent|representative|operator|customer service|customer care|customer support)$/u,
      /\b(?:talk|speak|chat) (?:to|with) (?:a |an |the |your |some |real |live |human )*(?:human|person|people|agent|representative|someone|somebody|operator|staff|team member|customer service|customer care|support team|manager|supervisor)\b/u,
      /\b(?:connect|put) me (?:through )?(?:to|with) (?:a |an |the |your |real |live |human )*(?:human|person|agent|representative|someone|somebody|operator|staff|customer service|customer care|support|manager|supervisor)\b/u,
      /\b(?:i want|i need|i'd like|i would like|can i have|give me|get me) (?:a |an |to |the )*(?:human|real person|live person|live agent|human agent|representative|customer service|customer care|manager|supervisor)\b/u,
    )(t) && !(EN_SELF_QUESTION.test(t) && !rx(/\b(?:talk|speak|chat|connect|want|need)\b/u).test(t)),
  help: any(/^(?:please )?(?:help|help me|help pls|help please|i need help|i need some help|need help|sos)(?: please)?$/u),
  cancel: (t) =>
    t.split(' ').length <= MAX_CANCEL_WORDS &&
    any(
      /^(?:please )?(?:i want to |i'd like to |i would like to |can you |can i |pls )?cancel(?: it| this| that| the| my| last| latest| transfer| payment| send| money| please| now)*$/u,
      /^(?:please )?stop (?:the|my) (?:transfer|payment)(?: please)?$/u,
    )(t),
};

// ── Hindi, Devanagari ────────────────────────────────────────────────────────
const HI_MONEY = rx(/(?:पैसे|पैसा|रकम|राशि|पेमेंट|ट्रांसफर|रुपये|रुपए)/u);
const HI: Rules = {
  unauthorised: any(/(?:धोखा|धोखाधड़ी|फ्रॉड|स्कैम|हैक|चोरी)/u, /मैंने (?:यह |ये |कोई )?(?:\S+ )?नहीं (?:भेजा|भेजे|किया|किए)/u),
  money_problem: (t) =>
    (HI_MONEY.test(t) && rx(/(?:नहीं (?:मिल|पहुं|पहुँ|आए|आया|आये)|गायब)/u).test(t)) || rx(/गलत (?:राशि|रकम|खाते|खाता|व्यक्ति|नंबर)/u).test(t),
  complaint: (t) => rx(/शिकायत/u).test(t) && !rx(/कोई शिकायत नहीं/u).test(t),
  human: any(/(?:इंसान|व्यक्ति|एजेंट|ग्राहक सेवा|कस्टमर केयर|कस्टमर सर्विस|किसी) से बात/u, /^(?:एजेंट|इंसान|ग्राहक सेवा)$/u),
  help: any(/^(?:मुझे )?(?:मदद|सहायता|हेल्प)(?: करें| करो| कीजिए| चाहिए)?$/u),
  cancel: (t) => t.split(' ').length <= MAX_CANCEL_WORDS && rx(/(?:रद्द|कैंसल)/u).test(t),
};

// ── Hinglish (Hindi in Roman letters) ────────────────────────────────────────
const HL_NOT = '(?:nahi|nahin|nhi|nai)';
const HL: Rules = {
  unauthorised: any(
    /\b(?:dhokha|dhoka|dhokhadhadi|dhokebaazi)\b/u,
    `\\bmaine\\b(?:\\s+\\S+){0,2}?\\s+${HL_NOT}\\s+(?:bheja|bheje|kiya|kiye|kari|kara)\\b`,
  ),
  money_problem: any(
    `\\b(?:paise|paisa|paisay|rupaye|rupay|amount|payment|transfer|rakam)\\b(?:\\s+\\S+){0,3}?\\s+${HL_NOT}\\s+(?:mile|mila|mili|aaye|aaya|aayi|aya|aye|pahuch|pahunch|pahuche|pahuncha|pahunche|pohcha|pohche)`,
    /\bgalat\s+(?:amount|account|khata|khate|insaan|person|number|aadmi)\b/u,
  ),
  complaint: (t) =>
    (rx(/\bshikaa?yat\b/u).test(t) && !rx(`\\bkoi shikaa?yat ${HL_NOT}\\b`).test(t)) ||
    rx(/\bcomplaint\s+(?:karni|karna|darj|deni|dena)\b/u).test(t),
  human: any(
    /\b(?:insaan|insan|vyakti|aadmi|admi|agent|customer care|customer service|kisi|real person|human|person)\s+(?:se|sey)\s+(?:baat|bat)\b/u,
  ),
  help: any(/^(?:mujhe )?(?:madad|help|sahayata)\s+(?:chahiye|karo|kijiye|kariye|karein|chaiye)$/u, /^madad$/u),
  cancel: (t) =>
    t.split(' ').length <= MAX_CANCEL_WORDS &&
    rx(/^(?:mera |meri |ye |yeh |ise |isko )?(?:transfer |payment |paise )?(?:cancel|radd)\s+(?:karo|kar do|kardo|kijiye|karna hai|karni hai|kar dijiye|karein|kariye)$/u).test(t),
};

// ── Spanish ──────────────────────────────────────────────────────────────────
const ES_MONEY = rx(/\b(?:dinero|plata|pago|transferencia|envío|envio|monto|cantidad|fondos|remesa)\b/u);
const ES: Rules = {
  unauthorised: any(
    /\b(?:fraude|estafa|estafaron|estafado|estafada|hackearon|hackeado|hackeada|robaron|robo|no autoricé|no autorice|no autorizado|no autorizada)\b/u,
    /\byo no (?:hice|envié|envie|autoricé|autorice|mandé|mande)\b/u,
  ),
  money_problem: (t) =>
    (ES_MONEY.test(t) &&
      rx(/\b(?:no (?:ha |han |le |me )?(?:llegado|llegó|llego|recibido|recibió|recibio|recibí|recibi|recibieron)|nunca (?:llegó|llego|recibí|recibi|recibió|recibio)|(?:se )?(?:perdió|perdio|desapareció|desaparecio))\b/u).test(t)) ||
    rx(/\b(?:(?:monto|cantidad) (?:incorrect[oa]|equivocad[oa])|(?:persona|cuenta|número|numero) equivocad[oa]|me (?:cobraron|cobró|cobro) (?:dos veces|doble))\b/u).test(t),
  complaint: (t) =>
    rx(/\b(?:queja|reclamo|reclamación|reclamacion|quejarme)\b/u).test(t) && !rx(/\b(?:ninguna|sin|no tengo) (?:queja|quejas)\b/u).test(t),
  human: (t) =>
    !rx(/^(?:eres|es usted|usted es)\b/u).test(t) &&
    any(
      /^(?:un |una )?(?:agente|humano|persona|persona real|representante|asesor|operador|atención al cliente|atencion al cliente|servicio al cliente)$/u,
      /\b(?:hablar|comunicarme|contactar|conectarme|conectar|pasar|pásame|pasame)\b(?:\s+\S+){0,3}?\s+(?:persona|humano|agente|representante|alguien|operador|asesor|servicio al cliente|atención al cliente|atencion al cliente)\b/u,
      /\bquiero\b(?:\s+\S+){0,2}?\s+(?:un humano|una persona real|un agente|un representante|un asesor)\b/u,
    )(t),
  help: any(/^(?:por favor )?(?:ayuda|ayúdame|ayudame|necesito ayuda|socorro)(?: por favor)?$/u),
  cancel: (t) =>
    t.split(' ').length <= MAX_CANCEL_WORDS &&
    rx(/^(?:por favor )?(?:quiero |puede |puedes )?(?:cancelar|cancela|cancélalo|cancelalo|cancélala|cancelala|anular|anula)(?: la| el| mi)?(?: transferencia| envío| envio| pago)?(?: por favor)?$/u).test(t),
};

const DEVANAGARI = /[ऀ-ॿ]/u;
/** Highest priority first: when one message says two things, the more serious case is opened. */
const PRIORITY: readonly HelpIntent[] = ['unauthorised', 'money_problem', 'complaint', 'human', 'help', 'cancel'];

function firstMatch(t: string, rules: Rules): HelpIntent | null {
  for (const intent of PRIORITY) if (rules[intent]?.(t)) return intent;
  return null;
}

/** The help intent of one customer message, or null (the model reads it). Never throws. Pure. */
export function classifyHelpIntent(text: unknown): HelpIntentMatch | null {
  const t = normalizeChatText(text);
  if (t === '' || t.length > MAX_CLASSIFY_CHARS) return null;
  const order: Array<[HelpLang, Rules]> = DEVANAGARI.test(t)
    ? [['hi', HI], ['hinglish', HL], ['en', EN]]
    : [['hinglish', HL], ['es', ES], ['en', EN]];
  for (const [lang, rules] of order) {
    const intent = firstMatch(t, rules);
    if (intent) return { intent, lang };
  }
  return null;
}

/** Cancel records a case and lets the bot continue (owner decision Q-R43.1); every other intent is answered without the model. */
export function helpIntentSkipsModel(intent: HelpIntent): boolean {
  return intent !== 'cancel';
}

/** The fixed case reason an intent opens its case with. */
export function helpCaseReasonFor(intent: HelpIntent): HelpCaseReason {
  switch (intent) {
    case 'complaint':
      return 'complaint';
    case 'money_problem':
      return 'payment_problem';
    case 'unauthorised':
      return 'unauthorised';
    case 'cancel':
      return 'cancel_request';
    default:
      return 'question';
  }
}

/** Hindi in Devanagari is answered in Hinglish, as the bot does (prompt.ts LANGUAGE & LENGTH). */
export function helpReplyLang(lang: HelpLang): HelpReplyLang {
  return lang === 'hi' || lang === 'hinglish' ? 'hinglish' : lang;
}

function replyKind(intent: HelpIntent): HelpCaseReplyKind {
  if (intent === 'money_problem') return 'case_money';
  if (intent === 'unauthorised') return 'case_unauthorised';
  return 'case_opened';
}

/** The fixed reply after a help case was opened (hold-replies.ts), in the customer's language. */
export function helpIntentReply(match: HelpIntentMatch, opts: { caseId: string; channel: HelpReplyChannel }): string {
  return helpCaseReply(replyKind(match.intent), helpReplyLang(match.lang), opts);
}
