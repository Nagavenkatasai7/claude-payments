import { eq } from 'drizzle-orm';
import { getDb, type DbOrTx } from '@/db/client';
import { partners } from '@/db/schema';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { env } from '@/lib/env';
import {
  createPartnerIntegrationsStore,
  getPartnerIntegrationsStore,
  partnerForPhoneNumberId,
} from '@/lib/partner-integrations-store';
import { verifyPhoneNumberOwnership } from '@/lib/partner-integrations-verify';
import type { PartnerWhatsappConfig } from '@/lib/partner-integrations';
import { checkWhatsappConfig, type WaConfigField } from '@/lib/whatsapp-creds';
import { clearChannelHealthMarks, type ChannelTestResult } from '@/lib/channel-health';
import { getStore } from '@/lib/store';
import { logWarn } from '@/lib/log';
import type { PartnerId } from '@/lib/types';

// partner-whatsapp-config (UI redesign M3-13): the ONE WhatsApp channel config core. It was the body
// of the legacy admin actions (admin-dashboard/partners/actions.ts saveWhatsappConfigAction /
// testWhatsappConnectionAction); both the legacy tab and the /partner surface now call it, so the
// rules (number free, complete config, Graph ownership probe OUTSIDE the transaction, write + audit
// in ONE transaction, health marks) cannot drift apart.
//
// NOT a 'use server' module: these functions take a partnerId and trust it. Every caller gates
// first and passes an AUTHORIZED tenant (the legacy gatePartnerConfig, or the session tenant of
// requirePartnerStaff). Nothing here revalidates a path; the caller does.
//
// Secrets are write-only: blank means "keep the stored value", nothing here returns or logs a token,
// app secret or verify token (logs carry partnerId + an HTTP status only).

/** The lib's refusals. The message text is the legacy text, byte for byte; `code` is for callers. */
export type WhatsappConfigErrorCode = 'number_unavailable' | 'unverified' | 'incomplete';
export class WhatsappConfigError extends Error {
  readonly code: WhatsappConfigErrorCode;
  constructor(code: WhatsappConfigErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const NUMBER_UNAVAILABLE = 'That WhatsApp number cannot be used.';

// Write-only secret merge: a blank form field means "leave the stored secret
// unchanged" (secrets are never rendered back, so blank ≠ delete).
function keepOrUpdate(submitted: string, existing: string | undefined): string | undefined {
  const v = submitted.trim();
  return v !== '' ? v : existing;
}

/**
 * D11 (fix 1): a WhatsApp phone_number_id routes inbound traffic to ONE tenant,
 * so it is REFUSED when it is the platform's own number or already held by a
 * different partner. One generic message for both cases — the refusal must not
 * tell a partner who holds a number. The partial unique index
 * partner_integrations_wa_pnid is the race-proof last line.
 */
export async function assertPhoneNumberIdFree(partnerId: string, pnid: string | undefined): Promise<void> {
  if (!pnid) return;
  const holder = await partnerForPhoneNumberId(pnid);
  if (pnid === env.whatsappPhoneNumberId || (holder && holder !== partnerId)) {
    throw new WhatsappConfigError('number_unavailable', NUMBER_UNAVAILABLE);
  }
}

/** Same generic refusal when the partial unique index loses a race (SQLSTATE 23505). */
export function rethrowPnidConflict(e: unknown): never {
  // The partial unique index partner_integrations_wa_pnid is the race-proof
  // last line (two admins saving the same number at once). SAME generic
  // message as assertPhoneNumberIdFree — never who holds it, never "race".
  // drizzle wraps the driver error (DrizzleQueryError.cause — node_modules/drizzle-orm/errors.js).
  const err = e as { code?: string; cause?: { code?: string } } | null;
  if (err?.code === '23505' || err?.cause?.code === '23505') throw new WhatsappConfigError('number_unavailable', NUMBER_UNAVAILABLE);
  throw e;
}

/**
 * Program-Fix 30 (F64): a pnid alone routes inbound traffic on the shared
 * webhook, so it must be PROVEN before it is stored: the access token has to
 * read that phone number from Meta (GET /{pnid}, plus /{waba}/phone_numbers
 * when a WABA id is given). A pnid with no token is refused outright.
 * Fail-closed, one generic message (never why, never who holds the number).
 * Logs partnerId + status only — never the token, never the pnid.
 */
const PNID_UNVERIFIED = 'That WhatsApp number could not be verified with this access token.';
export async function assertPhoneNumberIdOwned(
  partnerId: string,
  pnid: string,
  token: string | undefined,
  wabaId: string | undefined,
): Promise<void> {
  if (!token) {
    logWarn('wa.pnid_verify_failed', 'pnid registration refused: no access token', { partnerId, status: 'no_token' });
    throw new WhatsappConfigError('unverified', PNID_UNVERIFIED);
  }
  const r = await verifyPhoneNumberOwnership({ pnid, token, wabaId });
  if (!r.ok) {
    logWarn('wa.pnid_verify_failed', 'pnid ownership check failed', { partnerId, status: r.status ?? 'network_or_invalid' });
    throw new WhatsappConfigError('unverified', PNID_UNVERIFIED);
  }
}

/**
 * R2a: the SAVE rule on the MERGED WhatsApp state (checkWhatsappConfig): either
 * nothing set, or pnid + token + app secret. A partial state would save and then
 * fail closed at send time, so it is refused here with the missing fields named.
 */
const WA_FIELD_LABEL: Record<WaConfigField, string> = {
  phoneNumberId: 'Phone number ID',
  token: 'Access token',
  appSecret: 'App secret',
  verifyToken: 'Verify token',
};
export function assertWhatsappConfigComplete(w: PartnerWhatsappConfig): void {
  const check = checkWhatsappConfig(w);
  if (!check.ok) {
    throw new WhatsappConfigError(
      'incomplete',
      `WhatsApp setup is incomplete — also provide: ${check.missing.map((f) => WA_FIELD_LABEL[f]).join(', ')}. Or tick "Disconnect WhatsApp" to use the shared SmartRemit number.`,
    );
  }
}

/**
 * partner-demo R3a (M4): which WhatsApp fields a save changed — BOOLEANS ONLY.
 * Never a value, a last4 of a token, or a hash (the audit row must not help
 * anyone guess or confirm a secret).
 */
export function whatsappAuditMeta(before: PartnerWhatsappConfig, after: PartnerWhatsappConfig) {
  return {
    pnidChanged: (after.phoneNumberId ?? '') !== (before.phoneNumberId ?? ''),
    tokenChanged: (after.token ?? '') !== (before.token ?? ''),
    verifyTokenChanged: (after.verifyToken ?? '') !== (before.verifyToken ?? ''),
    appSecretChanged: (after.appSecret ?? '') !== (before.appSecret ?? ''),
    pnidCleared: !after.phoneNumberId && Boolean(before.phoneNumberId),
  };
}

/** The submitted WhatsApp form, as raw strings (blank secret ⇒ keep the stored one). */
export interface WhatsappConfigForm {
  phoneNumberId: string;
  token: string;
  verifyToken: string;
  appSecret: string;
  /** Read ONLY for the ownership check; never persisted. */
  wabaId: string;
}

export interface WhatsappWriteOpts {
  /**
   * The audit row's actor scope marker (#405: an unmarked row cannot be attributed). The caller
   * DERIVES it from the authenticated session (scopeOf(staff).kind), never from input. Absent ⇒ the
   * legacy row shape (no marker), which the legacy tab keeps for parity.
   */
  actorScope?: 'partner' | 'platform';
  /**
   * A blank phone number id keeps the stored one (the /partner page never renders the id back, so
   * it cannot prefill it). Absent ⇒ the legacy rule: a blank id clears it.
   */
  blankPnidKeeps?: boolean;
}

/**
 * R2a: an explicit disconnect wipes all four fields (blank fields otherwise
 * KEEP stored secrets, so without this a config could never be cleared).
 * R3a: audited in the same transaction — actor + partnerId only.
 */
/**
 * M3-15a review M1: saveIntegrations rewrites the WHOLE row (integrations-repo.ts saveIntegrations),
 * so a writer must not write back payment/KYC columns it read before its transaction: a settlement
 * secret rotated meanwhile (partner-settlement-endpoint.ts, same lock) would be silently undone. Lock
 * the tenant's partners row (the per-tenant mutex those writers share) and re-read inside the tx.
 */
async function lockedIntegrations(tx: DbOrTx, partnerId: PartnerId) {
  await tx.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).for('update');
  return createPartnerIntegrationsStore(tx).getIntegrations(partnerId);
}

export async function disconnectWhatsapp(partnerId: PartnerId, actor: string, opts: WhatsappWriteOpts = {}): Promise<void> {
  const existing = await getPartnerIntegrationsStore().getIntegrations(partnerId);
  await getDb().transaction(async (tx) => {
    const fresh = await lockedIntegrations(tx, partnerId);
    await createPartnerIntegrationsStore(tx).saveIntegrations(partnerId, { ...fresh, whatsapp: {} });
    await createAuditRepo(tx).record({
      partnerId,
      actor,
      actorType: 'staff',
      action: 'partner.whatsapp.disconnect',
      subjectId: partnerId,
      ...(opts.actorScope ? { meta: { actorScope: opts.actorScope } } : {}),
    });
  });
  await clearChannelHealthMarks(partnerId, ['auth_error', 'incomplete_config']);
}

export async function saveWhatsappConfig(
  partnerId: PartnerId,
  actor: string,
  form: WhatsappConfigForm,
  opts: WhatsappWriteOpts = {},
): Promise<void> {
  const existing = await getPartnerIntegrationsStore().getIntegrations(partnerId);
  const submittedPnid = form.phoneNumberId.trim();
  const newPnid = submittedPnid === '' && opts.blankPnidKeeps ? (existing.whatsapp.phoneNumberId ?? '') : submittedPnid;
  await assertPhoneNumberIdFree(partnerId, newPnid || undefined);
  const whatsapp: PartnerWhatsappConfig = {
    phoneNumberId: newPnid || undefined,
    token: keepOrUpdate(form.token, existing.whatsapp.token),
    verifyToken: keepOrUpdate(form.verifyToken, existing.whatsapp.verifyToken),
    appSecret: keepOrUpdate(form.appSecret, existing.whatsapp.appSecret),
  };
  // R2a rule on the MERGED state; R3a moved it BEFORE the Graph probe, so an
  // incomplete form never costs a network call.
  assertWhatsappConfigComplete(whatsapp);
  // Fix 30: verify only when the pnid changes, or a NEW token arrives while a
  // pnid is set. A save changing neither (e.g. only the verify token) is
  // grandfathered — no Graph call. Clearing the pnid needs no proof.
  const submittedToken = form.token.trim();
  const pnidChanged = newPnid !== (existing.whatsapp.phoneNumberId ?? '');
  const tokenChanged = submittedToken !== '' && submittedToken !== existing.whatsapp.token;
  const probed = Boolean(newPnid && (pnidChanged || tokenChanged));
  if (probed) {
    // wabaId is read ONLY for this check; it is never persisted.
    const wabaId = form.wabaId.trim() || undefined;
    // R3a (R7 review): the Graph call stays BEFORE the transaction — never
    // network I/O while holding a database transaction open.
    await assertPhoneNumberIdOwned(partnerId, newPnid, submittedToken || existing.whatsapp.token, wabaId);
  }
  try {
    // R3a (M4): the write and its audit row commit together, or neither does.
    await getDb().transaction(async (tx) => {
      // Only the WhatsApp fields come from this write; every other column is re-read under the lock.
      const fresh = await lockedIntegrations(tx, partnerId);
      await createPartnerIntegrationsStore(tx).saveIntegrations(partnerId, { ...fresh, whatsapp });
      await createAuditRepo(tx).record({
        partnerId,
        actor,
        actorType: 'staff',
        action: 'partner.whatsapp_config',
        subjectId: partnerId,
        meta: {
          ...whatsappAuditMeta(existing.whatsapp, whatsapp),
          ...(opts.actorScope ? { actorScope: opts.actorScope } : {}),
        },
      });
    });
  } catch (e) {
    rethrowPnidConflict(e);
  }
  // A saved (complete) config resolves the incomplete signal. auth_error is
  // resolved ONLY when this save's token just passed the Graph probe — a
  // blank-field or verify-token-only save still holds the rejected token.
  await clearChannelHealthMarks(partnerId, probed ? ['auth_error', 'incomplete_config'] : ['incomplete_config']);
  // No separate reverse index to maintain anymore — inbound routing resolves
  // the partner straight off the integrations row (partnerForPhoneNumberId).
}

/**
 * R2a: "Test connection" — the SAME Graph ownership probe the save runs
 * (verifyPhoneNumberOwnership, GET /{pnid} with the STORED token of THIS
 * partner; never the shared number's credentials), on demand. Network I/O only,
 * no DB transaction. The result (ok + HTTP status only — never the token or
 * body) is kept in Redis for the WhatsApp tab; a pass clears a stale auth_error mark.
 */
export async function testWhatsappConnection(partnerId: PartnerId): Promise<ChannelTestResult> {
  const { whatsapp } = await getPartnerIntegrationsStore().getIntegrations(partnerId);
  const at = new Date().toISOString();
  let result: ChannelTestResult;
  if (!whatsapp.phoneNumberId || !whatsapp.token) {
    result = { ok: false, at, reason: 'not_configured' };
  } else {
    const r = await verifyPhoneNumberOwnership({ pnid: whatsapp.phoneNumberId, token: whatsapp.token });
    result = r.ok ? { ok: true, at } : { ok: false, at, reason: 'probe_failed', ...(r.status !== undefined ? { status: r.status } : {}) };
    if (!r.ok) logWarn('wa.test_connection_failed', 'WhatsApp test connection failed', { partnerId, status: r.status ?? 'network_or_invalid' });
  }
  try {
    await getStore().writeChannelTest(partnerId, JSON.stringify(result));
  } catch (err) {
    logWarn('wa.test_connection', 'result not stored', { partnerId, error: err instanceof Error ? err.name : 'error' });
  }
  if (result.ok) await clearChannelHealthMarks(partnerId, ['auth_error']);
  return result;
}
