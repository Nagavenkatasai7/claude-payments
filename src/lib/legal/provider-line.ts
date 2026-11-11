// Fix pack 4 (C16, R16): the one approved provider line,
// "Payments by <licensed entity>, licensed by <state regulator>".
//
// PURE (imports: the ResolvedDisclosure type and the persona's rule-override check). Shown only for the OWNER's approved provider block
// (partner admin's stamp matches the block's hash): null for demo, the default
// tenant, a pending or unapproved block, or a block without a regulator. Never a
// licence id, phone or URL. A value naming the platform brand reads null too
// (critic P10: the claims register bans that wording; landing-claims scans
// source files, not this runtime value). Surfaces call it only through
// `providerLineFor(resolvePartnerDisclosure(owner))` (C22).

import type { ResolvedDisclosure } from '../partner-config';
import { hasOverridePhrase } from '../untrusted-text';

export const PROVIDER_LINE_TEMPLATE = 'Payments by {entity}, licensed by {regulator}';

const PLATFORM_NAME = /smartremit/i;

/**
 * Review R3-Y1 O2 (D4): whether a licensed-entity or regulator name names the platform brand (any
 * case, also after NFKC). The ONE rule: providerLineFor reads null on it, and the partner form
 * (parseDisclosureForm) refuses such a name, so an approved block always builds a line. Pure.
 */
export function namesPlatform(v: string): boolean {
  return PLATFORM_NAME.test(v) || PLATFORM_NAME.test(v.normalize('NFKC'));
}

// Review R1-P5 (C1): the line reaches the bot's system prompt, so the two partner-written names
// may not carry a double quote of any form, a backtick or a line break, nor the persona's
// rule-override phrase (hasOverridePhrase, the one list). The partner form refuses such a name
// (parseDisclosureForm), and a stored legacy value reads null here.
// Review R3-Y1 O1: "any form" is ASCII and fullwidth (via NFKC), curly and low-9 quotes, the double
// primes U+2033 / U+2036 / U+301D-U+301F / U+02BA, the ditto mark U+3003, guillemets U+00AB / U+00BB
// and the ornament quotes U+275D / U+275E. NFKC splits U+2033 into two U+2032 and U+2036 into two
// U+2035, so the class runs on the RAW value as well as the NFKC one, and a doubled single prime is
// refused too. An apostrophe (ASCII or U+2019) and a lone prime stay allowed.
const QUOTE_LIKE = /["`\u00ab\u00bb\u02ba\u201c\u201d\u201e\u201f\u2033\u2036\u275d\u275e\u3003\u301d\u301e\u301f]|\u2032\u2032|\u2035\u2035/u;
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/u;

/** Whether a licensed-entity or regulator name is safe to build the provider line from. Pure. */
export function isProviderNameText(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const n = v.normalize('NFKC');
  return !QUOTE_LIKE.test(v) && !QUOTE_LIKE.test(n) && !LINE_BREAK.test(n) && !hasOverridePhrase(n);
}

const flatten = (v: string | null | undefined): string => (v ?? '').replace(/\s+/g, ' ').trim();

// Review R2-Q1 K1: the one bound for the line. A longer line is never shown (providerLineFor reads
// null) and the partner form refuses a block that would build one (parseDisclosureForm), so the
// chat surfaces' own bounding call (hold-replies, the Approve card, the prompt) never cuts it.
// Measured in NFKC code points, as boundUntrustedText measures.
export const PROVIDER_LINE_MAX = 200;

const buildLine = (entity: string, regulator: string): string =>
  // One pass, so a value that contains a placeholder is never substituted again.
  PROVIDER_LINE_TEMPLATE.replace(/\{(entity|regulator)\}/g, (_m, k: string) => (k === 'entity' ? entity : regulator));

/** Whether the line built from these two names (flattened) fits PROVIDER_LINE_MAX. Pure. */
export function providerLineFits(entity: string, regulator: string): boolean {
  return [...buildLine(flatten(entity), flatten(regulator)).normalize('NFKC')].length <= PROVIDER_LINE_MAX;
}

export function providerLineFor(d: ResolvedDisclosure | null | undefined): string | null {
  if (!d || d.demo || !d.configured || !d.partnerApproved) return null;
  const entity = flatten(d.licensedEntity);
  const regulator = flatten(d.stateRegulator?.name);
  if (entity === '' || regulator === '') return null;
  if (namesPlatform(entity) || namesPlatform(regulator)) return null;
  // Checked on the flattened values: a legacy line break is already a space (as before).
  if (!isProviderNameText(entity) || !isProviderNameText(regulator)) return null;
  if (!providerLineFits(entity, regulator)) return null;
  return buildLine(entity, regulator);
}
