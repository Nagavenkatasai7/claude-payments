// key-id (Program-Fix 45) — THE grammar of a field-crypto key id, shared by
// field-crypto.ts (reader + writer) and boot-assert.ts (the optional
// FIELD_ENCRYPTION_CURRENT_KID check). Pure, no imports: boot-assert must stay
// runtime-agnostic. One definition, so the assert can never accept a kid the
// code refuses (or refuse one it accepts) — the FIELD_ENCRYPTION_KEY incident.
//
// `k0`, `k1` … `k999`, no leading zeros, so one kid has exactly one spelling
// (the AAD binds its bytes). k0 is always FIELD_ENCRYPTION_KEY.

export const KID_PATTERN = /^k(?:0|[1-9][0-9]{0,2})$/;
export const K0 = 'k0';

export const isKid = (kid: unknown): kid is string => typeof kid === 'string' && KID_PATTERN.test(kid);
