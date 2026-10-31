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
 * R20 adds the public-page register (BANNED_PUBLIC_CLAIMS) next to this one.
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
