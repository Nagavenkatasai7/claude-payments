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

// Review R1-P5 (C1): the line reaches the bot's system prompt, so the two partner-written names
// may not carry a double quote (ASCII, fullwidth via NFKC, curly or prime), a backtick or a line
// break, nor the persona's rule-override phrase (hasOverridePhrase, the one list). The partner
// form refuses such a name (parseDisclosureForm), and a stored legacy value reads null here.
const QUOTE_LIKE = /["`\u201c\u201d\u201e\u201f\u2033\u2036\u301d\u301e]/u;
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/u;

/** Whether a licensed-entity or regulator name is safe to build the provider line from. Pure. */
export function isProviderNameText(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const n = v.normalize('NFKC');
  return !QUOTE_LIKE.test(n) && !LINE_BREAK.test(n) && !hasOverridePhrase(n);
}

const flatten = (v: string | null | undefined): string => (v ?? '').replace(/\s+/g, ' ').trim();

export function providerLineFor(d: ResolvedDisclosure | null | undefined): string | null {
  if (!d || d.demo || !d.configured || !d.partnerApproved) return null;
  const entity = flatten(d.licensedEntity);
  const regulator = flatten(d.stateRegulator?.name);
  if (entity === '' || regulator === '') return null;
  if (PLATFORM_NAME.test(entity) || PLATFORM_NAME.test(regulator)) return null;
  // Checked on the flattened values: a legacy line break is already a space (as before).
  if (!isProviderNameText(entity) || !isProviderNameText(regulator)) return null;
  // One pass, so a value that contains a placeholder is never substituted again.
  return PROVIDER_LINE_TEMPLATE.replace(/\{(entity|regulator)\}/g, (_m, k: string) => (k === 'entity' ? entity : regulator));
}
