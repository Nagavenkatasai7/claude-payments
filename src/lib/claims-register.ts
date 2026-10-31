/**
 * claims-register — the claims SmartRemit must not make (R20, R32).
 *
 * BANNED_REPLY_CLAIMS are the delivery and outcome promises a bot reply may
 * never make: a transfer is never instant or delivered in minutes (the
 * customer is told the disclosed estimate, in business days), and nothing is
 * guaranteed. The reply guard (reply-guard.ts) flags a reply that makes one,
 * unless the claim is negated in the same clause ("not instant").
 *
 * Each pattern is matched against NFKC text, case-insensitive. Keep them
 * narrow: a false positive in shadow mode is an ops alert, and with the
 * agent.reply_guard switch on it replaces a customer's reply.
 *
 * BANNED_PUBLIC_CLAIMS (R20) are the claims the public pages may never make:
 * the home page, the about page, the docs and trust content and the legal
 * drafts. tests/landing-claims.test.ts runs findPublicClaims over every one of
 * those sources. APPROVED_PUBLIC_PHRASINGS is the other half of the register:
 * the way to say each thing, and the evidence behind it. Marketing and counsel
 * review both lists; a new claim on a public page starts here.
 */

export interface BannedClaim {
  /** A stable id, used in alerts and logs (never the reply text). */
  id: string;
  pattern: RegExp;
  /** Why it is banned, for the reviewer reading an alert. */
  why: string;
}

/** Words that, before the claim in the same clause, make it a denial ("not instant"). */
export const CLAIM_NEGATION =
  /(?:^|[^\p{L}])(?:not|never|no|can[’']?t|cannot|isn[’']?t|aren[’']?t|won[’']?t|wouldn[’']?t|don[’']?t|doesn[’']?t|nahi|nahin|nunca)(?:[^\p{L}][^.!?\n]*)?$/iu;

/** The delivery verbs a speed claim attaches to ("arrives", "receive it", "gets the money"). */
const DELIVERY_VERB = String.raw`(?:arriv\w*|deliver\w*|credited|receiv\w*|gets? (?:it|the money|their money|the funds))`;

export const BANNED_REPLY_CLAIMS: readonly BannedClaim[] = [
  {
    id: 'instant',
    pattern: /\binstant(?:ly|aneous(?:ly)?)?\b/iu,
    why: 'Delivery is never instant: the customer is told the disclosed estimate in business days.',
  },
  {
    id: 'minutes',
    pattern: new RegExp(
      String.raw`\b${DELIVERY_VERB}\b[^.!?\n]{0,30}?\b(?:within|in) (?:a (?:few )?|few |\d+(?:\s?[-–]\s?\d+)? )?(?:minutes?|mins?|seconds?|secs?)\b`,
      'iu',
    ),
    why: 'A delivery time in minutes or seconds is never disclosed: delivery is in business days.',
  },
  {
    id: 'immediate',
    pattern: new RegExp(String.raw`\b${DELIVERY_VERB}\b[^.!?\n]{0,20}?\b(?:immediately|right away|straight away)\b`, 'iu'),
    why: 'An immediate delivery is never disclosed: delivery is in business days.',
  },
  {
    id: 'guaranteed',
    pattern: /\bguarantee(?:d|s)?\b/iu,
    why: 'Nothing about a transfer, a refund or a recall is guaranteed.',
  },
];

/** Where a public claim is banned: 'site' is every public page source; 'home' adds the home page and its landing components. */
export type PublicClaimScope = 'site' | 'home';

export interface BannedPublicClaim extends BannedClaim {
  /** 'site': banned on every public page. 'home': banned on the home page only. */
  scope: PublicClaimScope;
}

/**
 * The public over-claims (R20). Each pattern runs on NFKC text with every run of
 * whitespace squashed to one space, so wrapped JSX text is matched as one line.
 * A claim negated in the same clause ("never guaranteed", "not instant") passes.
 */
export const BANNED_PUBLIC_CLAIMS: readonly BannedPublicClaim[] = [
  {
    id: 'instant',
    scope: 'site',
    pattern: /\binstant(?:ly|aneous(?:ly)?)?\b/iu,
    why: 'Delivery is never instant: the receipt states the disclosed delivery date.',
  },
  {
    id: 'delivery-minutes',
    scope: 'site',
    pattern: /\b(?:with)?in (?:a (?:few )?|few |under a )?(?:minutes?|seconds?)\b/iu,
    why: 'No delivery time in minutes or seconds is disclosed. A real window ("within 30 minutes of paying") names its number and passes.',
  },
  {
    id: 'guaranteed',
    scope: 'site',
    pattern: /\bguarantee(?:d|s)?\b/iu,
    why: 'Nothing about a transfer, its delivery date, a refund or a recall is guaranteed.',
  },
  {
    id: 'money-real-time',
    scope: 'site',
    pattern: /\bmoney (?:moves?|moving) in real[- ]time\b|\breal[- ]time (?:delivery|transfers?|payouts?)\b/iu,
    why: 'Money does not move in real time: payout runs on the licensed partner\u2019s rail, in business days.',
  },
  {
    id: 'encryption-overclaim',
    scope: 'site',
    pattern:
      /\b(?:PII|personal (?:data|information)|customer data|your data|all (?:of )?(?:your |customer |personal )?(?:data|information))\b[^.]{0,60}?\bencrypt\w*|\b(?:fully|end[- ]to[- ]end) encrypt\w*|\brecipient names (?:are|is) encrypted\b/iu,
    why: 'Only named fields are encrypted (payout details, legal names, identity data, integration secrets). Phone numbers, the chat recipient name, support messages and the recent chat history are not yet (crypto-06).',
  },
  {
    id: 'audit-overclaim',
    scope: 'site',
    pattern: /\bfull audit trail\b|\bevery step (?:is )?(?:signed and )?audited\b|\b(?:everything|every action) is (?:logged|audited|recorded)\b|\bend[- ]to[- ]end audit\w*/iu,
    why: 'Not every step has a durable audit row (the code check, AI-app calls best effort). Say what is logged: staff reveals, KYC decisions, blocked attempts.',
  },
  {
    id: 'safety-overclaim',
    scope: 'site',
    pattern: /\bsafe and secure\b|\bsafe by construction\b|\b(?:bank|military)[- ]grade\b|\b100% (?:safe|secure)\b|\bcompletely (?:safe|secure)\b|\brisk[- ]free\b/iu,
    why: 'A general safety promise has no evidence behind it. State the specific control instead.',
  },
  {
    id: 'whole-transfer-in-chat',
    scope: 'site',
    pattern: /\b(?:entire|whole) (?:transfer|thing|send)\b[^.]{0,40}?\b(?:is|in|inside) a (?:WhatsApp )?(?:chat|conversation)\b/iu,
    why: 'The transfer is not all in the chat: the customer pays on the hosted pay page, with a code.',
  },
  {
    id: 'illustration-as-real',
    scope: 'site',
    pattern: /\b(?:a|this is a) (?:real|live) transfer (?:moving|flowing)\b/iu,
    why: 'The landing animation is an example, not a real or live transfer.',
  },
  {
    id: 'own-brand',
    scope: 'site',
    pattern: /\bunder (?:their|its|your) own brand(?:ing)?\b/iu,
    why: 'Branding decision (2026-10-04): customers see only SmartRemit; the licensed partner is named on the pay page and the receipt.',
  },
  {
    id: 'telegram-available-now',
    scope: 'site',
    pattern: /\bTelegram\b[^.]{0,80}?\bavailable now\b|\bavailable now\b[^.]{0,40}?\bTelegram\b/iu,
    why: 'Telegram serves invited phones only (telegram-inbound.ts): it is "By invitation" (Q11).',
  },
  {
    id: 'smartremit-licensed',
    scope: 'site',
    pattern:
      /\bSmartRemit(?: is| acts as|,)? (?:a |an |the )?(?:licensed|regulated)\b|\blicensed by SmartRemit\b|\bSmartRemit is (?:a |an |the )?(?:money transmitter|bank|remittance (?:company|provider)|money transfer (?:company|service|provider))\b/iu,
    why: 'SmartRemit is the technology provider. The licensed money transmitter provides the transfer.',
  },
  {
    id: 'smartremit-moves-money',
    scope: 'site',
    pattern: /\bSmartRemit (?:sends|moves|transfers|delivers|pays out|settles|remits)(?: (?:your|the|customer|customers\u2019?'?))? (?:money|funds|payments?)\b/iu,
    why: 'SmartRemit never sends, holds or settles the money: the licensed partner\u2019s rail does.',
  },
  {
    id: 'smartremit-service',
    scope: 'site',
    pattern: /\bSmartRemit\b(?:,| is)? (?:a|the) (?:money transfer |remittance )?service that (?:lets|helps) (?:people|you|customers) send money\b/iu,
    why: 'Holding out: SmartRemit is the technology that runs the chat and the pay page, not the money service.',
  },
  {
    id: 'named-ai-apps',
    scope: 'home',
    pattern: /\b(?:Claude|ChatGPT|Perplexity|Gemini|Copilot|OpenAI|Anthropic)\b/u,
    why: 'Q11: the home page does not name AI apps (no platform permission, and a name can read as endorsement). The AI-apps guide keeps each app\u2019s own connector steps.',
  },
];

/** The approved way to say something on a public page, with the evidence behind it. */
export interface ApprovedPhrasing {
  topic: string;
  say: string;
  evidence: string;
}

export const APPROVED_PUBLIC_PHRASINGS: readonly ApprovedPhrasing[] = [
  {
    topic: 'provider',
    say: 'A licensed money transmitter provides the transfer. SmartRemit provides the technology and never holds your money.',
    evidence: 'src/lib/legal/drafts.ts LICENSING_DRAFT (provider of record); the pay page and receipt name the partner (resolvePartnerDisclosure).',
  },
  {
    topic: 'custody',
    say: 'SmartRemit never holds, receives or disburses customer money: funds move only on the licensed partner\u2019s own payment rails.',
    evidence: 'src/lib/settlement.ts (a signed instruction, never a balance); CLAUDE.md "never holds funds".',
  },
  {
    topic: 'delivery',
    say: 'Delivery is not instant. Your receipt shows when the money is expected to arrive.',
    evidence: 'resolvePartnerDisclosure deliveryBusinessDays; the receipt disclosure (buildReceiptDisclosure).',
  },
  {
    topic: 'encryption',
    say: 'Payout account details, recipients\u2019 legal names, identity-verification data and integration secrets are encrypted at the field level (AES-256-GCM).',
    evidence: 'src/lib/field-crypto.ts; src/content/trust/security-overview.ts "Field-level encryption".',
  },
  {
    topic: 'staff-access',
    say: 'Every staff reveal of personal data is written to the audit log.',
    evidence: 'pii.reveal and pii.view rows in audit_events (CLAUDE.md, Encryption at rest).',
  },
  {
    topic: 'sanctions',
    say: 'Sanctions screening runs on every transfer (demo: reference list; production feed per partner).',
    evidence: 'Sanctions screening is structurally untoggleable (CLAUDE.md); tests/landing-claims.test.ts pins the demo qualifier.',
  },
  {
    topic: 'telegram',
    say: 'Telegram: by invitation.',
    evidence: 'src/lib/telegram-inbound.ts serves invited (demo-mode) phones only; owner answer Q11 (2026-10-31).',
  },
  {
    topic: 'ai-apps',
    say: 'AI assistants that support custom connectors: early access, by invitation. SmartRemit is not affiliated with or endorsed by any AI app maker.',
    evidence: 'src/content/docs/ai-apps.mdx (switched on per account, in no public directory); owner answer Q11 (2026-10-31).',
  },
  {
    topic: 'ai-chat',
    say: 'The chat is run by an AI assistant, and it says so when a conversation starts. Reply HELP at any time to reach a person.',
    evidence: 'src/lib/ai-notice.ts (the AI notice, R17); src/lib/help-intents.ts (HELP opens a case, R43).',
  },
];

export interface PublicClaimHit {
  /** The BannedPublicClaim id. */
  id: string;
  /** Up to 120 characters around the hit, for the failing test's message. */
  excerpt: string;
}

const EXCERPT_MAX = 120;

/**
 * Find the banned public claims in a page source. 'site' checks the claims
 * banned everywhere; 'home' also checks the home-page-only ones.
 */
export function findPublicClaims(text: string, scope: PublicClaimScope = 'site'): PublicClaimHit[] {
  const flat = text.normalize('NFKC').replace(/\s+/g, ' ');
  const hits: PublicClaimHit[] = [];
  for (const claim of BANNED_PUBLIC_CLAIMS) {
    if (claim.scope === 'home' && scope !== 'home') continue;
    const flags = claim.pattern.flags.includes('g') ? claim.pattern.flags : `${claim.pattern.flags}g`;
    for (const m of flat.matchAll(new RegExp(claim.pattern.source, flags))) {
      const at = m.index ?? 0;
      if (CLAIM_NEGATION.test(flat.slice(Math.max(0, at - 30), at))) continue;
      const start = Math.max(0, at - 30);
      hits.push({ id: claim.id, excerpt: flat.slice(start, Math.min(flat.length, at + m[0].length + 30)).slice(0, EXCERPT_MAX).trim() });
    }
  }
  return hits;
}
