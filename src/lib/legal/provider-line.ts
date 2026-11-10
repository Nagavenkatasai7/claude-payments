// Fix pack 4 (C16, R16): the one approved provider line,
// "Payments by <licensed entity>, licensed by <state regulator>".
//
// PURE, type-only imports. Shown only for the OWNER's approved provider block
// (partner admin's stamp matches the block's hash): null for demo, the default
// tenant, a pending or unapproved block, or a block without a regulator. Never a
// licence id, phone or URL. A value naming the platform brand reads null too
// (critic P10: the claims register bans that wording; landing-claims scans
// source files, not this runtime value). Surfaces call it only through
// `providerLineFor(resolvePartnerDisclosure(owner))` (C22).

import type { ResolvedDisclosure } from '../partner-config';

export const PROVIDER_LINE_TEMPLATE = 'Payments by {entity}, licensed by {regulator}';

const PLATFORM_NAME = /smartremit/i;

const flatten = (v: string | null | undefined): string => (v ?? '').replace(/\s+/g, ' ').trim();

export function providerLineFor(d: ResolvedDisclosure | null | undefined): string | null {
  if (!d || d.demo || !d.configured || !d.partnerApproved) return null;
  const entity = flatten(d.licensedEntity);
  const regulator = flatten(d.stateRegulator?.name);
  if (entity === '' || regulator === '') return null;
  if (PLATFORM_NAME.test(entity) || PLATFORM_NAME.test(regulator)) return null;
  // One pass, so a value that contains a placeholder is never substituted again.
  return PROVIDER_LINE_TEMPLATE.replace(/\{(entity|regulator)\}/g, (_m, k: string) => (k === 'entity' ? entity : regulator));
}
