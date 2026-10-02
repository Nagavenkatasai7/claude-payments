// partner-brand-text: the partner-written brand text that is interpolated into the bot's SYSTEM
// prompt — the display name and the bot persona. Shared by the legacy "My partner" actions
// (updatePartnerAction, the setup wizard) and /partner/branding.
//   - fix 5 (F43): both are stripped of control characters, line separators and []{}<> and capped
//     (BRAND_MAX / PERSONA_MAX). Stripped, not refused, so an existing value still saves;
//     buildSystemPrompt clamps again at read for pre-fix rows.
//   - Program-Fix 38: the persona may set tone only. A web address or a rule-override phrase is
//     REFUSED before any write, with one generic message whichever check tripped.
// The writers are column-only UPDATEs (never a full-row savePartner, which would rewrite every
// other column from a possibly stale read) with their audit row in the SAME transaction. The audit
// meta holds the lengths only, never the text. An unchanged value writes nothing.
import { eq } from 'drizzle-orm';
import { partners } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { boundUntrustedText, BRAND_MAX, hasOverridePhrase, hasWebAddress, PERSONA_MAX } from '@/lib/untrusted-text';
import type { PartnerId } from '@/lib/types';

export const PERSONA_REFUSAL = 'Bot voice can describe tone only — no web addresses or instructions about rules.';

export type ActorScope = 'platform' | 'partner';
export type PersonaCheck = { ok: true; value: string | undefined } | { ok: false; reason: 'persona_refused' };
export type BrandTextResult = { ok: true } | { ok: false; reason: 'not_found' };
export type PersonaResult = BrandTextResult | { ok: false; reason: 'persona_refused' };

/** Pure: the bounded persona (undefined when blank), or a refusal. */
export function checkPersona(raw: unknown): PersonaCheck {
  const persona = boundUntrustedText(raw, PERSONA_MAX);
  if (persona !== '' && (hasWebAddress(persona) || hasOverridePhrase(persona))) return { ok: false, reason: 'persona_refused' };
  return { ok: true, value: persona || undefined };
}

/** The legacy contract: the bounded persona, or throws PERSONA_REFUSAL. */
export function boundedPersona(raw: unknown): string | undefined {
  const r = checkPersona(raw);
  if (!r.ok) throw new Error(PERSONA_REFUSAL);
  return r.value;
}

/** Pure: the bounded display name (undefined when blank). Never refused. */
export function boundedDisplayName(raw: unknown): string | undefined {
  return boundUntrustedText(raw, BRAND_MAX) || undefined;
}

const len = (v: string | null | undefined): number => [...(v ?? '')].length;

/** The audit row for a persona change: who, which tenant, and the lengths — never the text. */
export function personaAuditEvent(
  partnerId: string,
  actor: string,
  oldPersona: string | undefined,
  newPersona: string | undefined,
  actorScope?: ActorScope,
) {
  return {
    partnerId,
    actor,
    actorType: 'staff' as const,
    action: 'partner.persona.update',
    subjectId: partnerId,
    meta: { oldLength: len(oldPersona), newLength: len(newPersona), ...(actorScope ? { actorScope } : {}) },
  };
}

type TxRunner = { transaction?: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> };
/** Run `fn` in a transaction when holding a Db; inside an existing tx, share it. */
function inTx<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  const maybeTx = db as TxRunner;
  return maybeTx.transaction ? maybeTx.transaction(fn) : fn(db);
}

/**
 * Validate, then in ONE transaction: read bot_persona under FOR UPDATE (no row → not_found), and
 * when it changes, UPDATE that column only plus one `partner.persona.update` audit row.
 */
export async function setPartnerPersona(
  db: DbOrTx,
  partnerId: PartnerId,
  raw: unknown,
  actor: string,
  opts: { actorScope: ActorScope },
): Promise<PersonaResult> {
  const v = checkPersona(raw);
  if (!v.ok) return v;
  const next = v.value;
  return inTx(db, async (tx) => {
    const rows = await tx.select({ v: partners.botPersona }).from(partners).where(eq(partners.id, partnerId)).limit(1).for('update');
    if (!rows[0]) return { ok: false, reason: 'not_found' } as const;
    const prev = rows[0].v ?? undefined;
    if ((prev ?? '') === (next ?? '')) return { ok: true } as const;
    await tx.update(partners).set({ botPersona: next ?? null, updatedAt: new Date() }).where(eq(partners.id, partnerId));
    await createAuditRepo(tx).record(personaAuditEvent(partnerId, actor, prev, next, opts.actorScope));
    return { ok: true } as const;
  });
}

/**
 * Bound, then in ONE transaction: read display_name under FOR UPDATE (no row → not_found), and when
 * it changes, UPDATE that column only plus one `partner.display_name.update` audit row (lengths).
 */
export async function setPartnerDisplayName(
  db: DbOrTx,
  partnerId: PartnerId,
  raw: unknown,
  actor: string,
  opts: { actorScope: ActorScope },
): Promise<BrandTextResult> {
  const next = boundedDisplayName(raw);
  return inTx(db, async (tx) => {
    const rows = await tx.select({ v: partners.displayName }).from(partners).where(eq(partners.id, partnerId)).limit(1).for('update');
    if (!rows[0]) return { ok: false, reason: 'not_found' } as const;
    const prev = rows[0].v ?? undefined;
    if ((prev ?? '') === (next ?? '')) return { ok: true } as const;
    await tx.update(partners).set({ displayName: next ?? null, updatedAt: new Date() }).where(eq(partners.id, partnerId));
    await createAuditRepo(tx).record({
      partnerId,
      actor,
      actorType: 'staff',
      action: 'partner.display_name.update',
      subjectId: partnerId,
      meta: { oldLength: len(prev), newLength: len(next), actorScope: opts.actorScope },
    });
    return { ok: true } as const;
  });
}
