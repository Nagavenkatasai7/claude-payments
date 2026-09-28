import { createHmac, hkdfSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '@/db/client';
import { createAuditRepo, createRecipientRepo } from '@/db/repos/aux-repos';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import { decodeMasterKey } from './field-crypto';
import { env } from './env';
import { auditSubjectId } from './customer-ref';
import { PORTAL_AUTH_ACTOR } from './portal-auth-audit';
import { BANK_FIELDS_BY_COUNTRY, validatePayoutFields } from './payout-format';
import { countryForPhone } from './partner-currency';
import { isValidPhone, normalizePhone } from './phone';
import type { MessageKey } from './i18n';
import type { CountryCode, PartnerId, PayoutMethod, Recipient, Schedule } from './types';

/**
 * portal-recipients — the customer portal's saved-recipient library (UI redesign M2-8). Server only.
 *
 * - The URL carries an opaque `rid`, never a phone: the first 32 hex chars of
 *   HMAC-SHA256(K, `partnerId|senderPhone|recipientPhone`), K = HKDF-SHA256(FIELD_ENCRYPTION_KEY,
 *   salt '', info RECIPIENT_RID_INFO, 32): the same sub-key family as customer-ref's threadKeyFor,
 *   under its OWN label (one key, one purpose).
 * - Every lookup is keyed by the host partner and the SESSION's phone; a rid that is malformed,
 *   random, another sender's or another tenant's resolves to the same null (the caller renders
 *   one "not found").
 * - A delete is a tombstone (the recipients row is kept) plus the cancel of every active or paused
 *   schedule to that recipient (owner O12), in ONE transaction, each step audited with ids and
 *   counts only.
 */

export const RECIPIENT_RID_INFO = 'recipient-rid-v1';
const RID_RE = /^[0-9a-f]{32}$/;

export const isRid = (v: unknown): v is string => typeof v === 'string' && RID_RE.test(v);

/** Derive the 32-byte rid key. Throws when the master key is missing or malformed. */
export function deriveRecipientRidKey(masterRaw: string | Buffer = env.fieldEncryptionKey): Buffer {
  return Buffer.from(hkdfSync('sha256', decodeMasterKey(masterRaw), '', RECIPIENT_RID_INFO, 32));
}

let cachedKey: Buffer | null = null;
function defaultKey(): Buffer {
  if (!cachedKey) cachedKey = deriveRecipientRidKey();
  return cachedKey;
}

/** The opaque, per-tenant recipient id (32 hex). Not reversible without the key. */
export function recipientRid(partnerId: PartnerId, senderPhone: string, recipientPhone: string, key: Buffer = defaultKey()): string {
  return createHmac('sha256', key).update(`${partnerId}|${senderPhone}|${recipientPhone}`).digest('hex').slice(0, 32);
}

/** The live saved recipient behind `rid` for THIS (tenant, sender), or null. */
export async function findByRid(db: DbOrTx, partnerId: PartnerId, senderPhone: string, rid: unknown): Promise<Recipient | null> {
  if (!isRid(rid)) return null;
  const all = await createRecipientRepo(db).listAllForSender(partnerId, senderPhone);
  return all.find((r) => recipientRid(partnerId, senderPhone, r.recipientPhone) === rid) ?? null;
}

// ── Edge validation ───────────────────────────────────────────────────────────

export const RECIPIENT_NAME_MAX = 80;
/** Per customer: adds, edits and deletes together (review DoD: `portal-recipient` 30/h). */
export const PORTAL_RECIPIENT_LIMIT = { scope: 'portal-recipient', limit: 30, windowSec: 3600 } as const;
export const PORTAL_RECIPIENTS_PAGE_SIZE = 50;

// C0/C1 controls, and the bidi embedding/override/isolate characters (a name must not reorder text).
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export function validateRecipientName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length === 0 || [...name].length > RECIPIENT_NAME_MAX || NAME_FORBIDDEN.test(name)) return null;
  return name;
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};

/** The destination countries the pay page collects bank details for. */
export const RECIPIENT_COUNTRIES = Object.keys(BANK_FIELDS_BY_COUNTRY) as CountryCode[];
const isCountry = (v: string): v is CountryCode => (RECIPIENT_COUNTRIES as string[]).includes(v);

/** Only the declared bank-field keys for `country` are read from the form (never an arbitrary key). */
function readBankFields(fd: FormData, country: CountryCode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of BANK_FIELDS_BY_COUNTRY[country]) out[def.key] = str(fd, def.key).slice(0, 64);
  return out;
}

export interface RecipientFormErrors {
  name?: MessageKey;
  recipientPhone?: MessageKey;
  country?: MessageKey;
  /** Per bank field, the pay page's own validator messages. */
  bank?: Record<string, string>;
}

export type AddInputResult =
  | { ok: true; value: { name: string; recipientPhone: string; payoutMethod: PayoutMethod; payoutDestination: string } }
  | { ok: false; errors: RecipientFormErrors };

/** Add: name, recipient phone (its calling code must be the chosen country) and bank details, via the pay page's validator. */
export function validateAddInput(fd: FormData): AddInputResult {
  const errors: RecipientFormErrors = {};
  const name = validateRecipientName(str(fd, 'name'));
  if (!name) errors.name = 'portal.recipients.name_invalid';
  const country = str(fd, 'country');
  const recipientPhone = normalizePhone(str(fd, 'recipientPhone').slice(0, 32));
  if (!isCountry(country)) {
    errors.country = 'portal.recipients.country_invalid';
  } else if (!isValidPhone(recipientPhone)) {
    errors.recipientPhone = 'portal.recipients.phone_invalid';
  } else if (countryForPhone(recipientPhone) !== country) {
    errors.recipientPhone = 'portal.recipients.phone_country';
  }
  let payoutDestination = '';
  if (isCountry(country)) {
    const v = validatePayoutFields(country, readBankFields(fd, country));
    if (v.ok) payoutDestination = v.payoutDestination;
    else errors.bank = v.errors;
  }
  if (Object.keys(errors).length > 0 || !name) return { ok: false, errors };
  return { ok: true, value: { name, recipientPhone, payoutMethod: 'bank', payoutDestination } };
}

export type EditInputResult =
  | { ok: true; value: { name: string; payoutMethod: PayoutMethod; payoutDestination: string; fields: Array<'name' | 'destination'> } }
  | { ok: false; errors: RecipientFormErrors };

/**
 * Edit: the name, and optionally NEW bank details (all blank = keep the current account). The key
 * (recipient phone) comes from the stored row, never the form. `fields` names what changed.
 */
export function validateEditInput(fd: FormData, existing: Recipient): EditInputResult {
  const errors: RecipientFormErrors = {};
  const name = validateRecipientName(str(fd, 'name'));
  if (!name) errors.name = 'portal.recipients.name_invalid';
  let payoutMethod = existing.payoutMethod;
  let payoutDestination = existing.payoutDestination;
  let destinationChanged = false;
  const country = countryForPhone(normalizePhone(existing.recipientPhone));
  if (country && isCountry(country)) {
    const fields = readBankFields(fd, country);
    if (Object.values(fields).some((v) => v.trim() !== '')) {
      const v = validatePayoutFields(country, fields);
      if (v.ok) {
        destinationChanged = v.payoutDestination !== existing.payoutDestination || existing.payoutMethod !== 'bank';
        payoutMethod = 'bank';
        payoutDestination = v.payoutDestination;
      } else {
        errors.bank = v.errors;
      }
    }
  }
  if (Object.keys(errors).length > 0 || !name) return { ok: false, errors };
  const changed: Array<'name' | 'destination'> = [];
  if (name !== existing.name) changed.push('name');
  if (destinationChanged) changed.push('destination');
  return { ok: true, value: { name, payoutMethod, payoutDestination, fields: changed } };
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export type RecipientAuditAction = 'recipient.create' | 'recipient.update' | 'recipient.delete' | 'schedule.cancel';
export type RecipientAuditMeta =
  | { rid: string; fields?: Array<'name' | 'destination'>; schedulesCancelled?: number }
  | { scheduleId: string; via: 'recipient_delete' };

const SCHEDULE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const FIELD_NAMES: ReadonlySet<unknown> = new Set(['name', 'destination']);

/** The meta allow-list: ids, field NAMES and counts only. Anything else throws (never a value). */
function checkMeta(meta: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(meta)) {
    const ok =
      (k === 'rid' && isRid(v)) ||
      (k === 'fields' && Array.isArray(v) && v.every((x) => FIELD_NAMES.has(x))) ||
      (k === 'schedulesCancelled' && Number.isInteger(v)) ||
      (k === 'scheduleId' && typeof v === 'string' && SCHEDULE_ID_RE.test(v)) ||
      (k === 'via' && v === 'recipient_delete');
    if (!ok) throw new Error('portal recipient audit: meta not allowed');
  }
}

/**
 * One audit row for a customer's own address-book change: actor `system:customer-portal` (AuditEvent
 * has no customer actor), subject = the keyed customer subject (never the phone). Throws on a guard
 * refusal or a DB failure (the caller's transaction then rolls back).
 */
export async function recordRecipientAudit(
  db: DbOrTx,
  e: { partnerId: PartnerId; phone: string; action: RecipientAuditAction; meta: RecipientAuditMeta },
): Promise<void> {
  checkMeta(e.meta as Record<string, unknown>);
  await createAuditRepo(db).record({
    partnerId: e.partnerId,
    actor: PORTAL_AUTH_ACTOR,
    actorType: 'system',
    action: e.action,
    subjectId: auditSubjectId(e.partnerId, normalizePhone(e.phone)),
    meta: e.meta,
  });
}

// ── Delete (owner O12) ────────────────────────────────────────────────────────

/**
 * UI redesign M2-10: the per-(tenant, sender) address-book lock, a transaction-scoped advisory lock
 * under its own key prefix (the mint's sender lock is `<partner>:<phone>`, store.ts). A recipient
 * delete and a portal schedule create both take it first, so a schedule can never be created to a
 * recipient whose delete is committing (the delete's schedule sweep would miss it).
 */
export async function lockRecipientBook(tx: DbOrTx, partnerId: PartnerId, phone: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`recipient-book:${partnerId}:${phone}`}))`);
}

const LIVE_SCHEDULE: ReadonlySet<string> = new Set(['active', 'paused']);

/** Active + paused schedules per NORMALIZED recipient phone (the delete dialog's "cancels N" count). */
export function scheduleCountsByRecipient(list: Schedule[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of list) {
    if (!LIVE_SCHEDULE.has(s.status)) continue;
    const k = normalizePhone(s.recipientPhone);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/**
 * Delete one saved recipient of (partnerId, phone): in ONE transaction, cancel each of the
 * customer's active or paused schedules to that recipient (the conditional writer setStatusIf; a
 * schedule keeps its own copy of the account, so a tombstone alone would leave it paying), write the
 * tombstone (the recipients row is kept) and audit every step. `{ ok: false }` when the rid does not
 * resolve for this customer (including an already-deleted recipient), with nothing written.
 */
export async function deleteRecipientWithSchedules(
  db: Db,
  partnerId: PartnerId,
  phone: string,
  rid: unknown,
): Promise<{ ok: true; schedulesCancelled: number } | { ok: false }> {
  if (!isRid(rid)) return { ok: false };
  return db.transaction(async (tx) => {
    await lockRecipientBook(tx, partnerId, phone); // M2-10: serialized with a portal schedule create
    const recipient = await findByRid(tx, partnerId, phone, rid);
    if (!recipient) return { ok: false as const };
    const target = normalizePhone(recipient.recipientPhone);
    const schedulesRepo = createScheduleRepo(tx);
    const mine = (await schedulesRepo.listForCustomer(partnerId, phone)).filter(
      (s) => LIVE_SCHEDULE.has(s.status) && normalizePhone(s.recipientPhone) === target,
    );
    let cancelled = 0;
    for (const s of mine) {
      const done = await schedulesRepo.setStatusIf(s.id, partnerId, ['active', 'paused'], 'cancelled');
      if (!done) continue; // lost a race: it already left active/paused
      cancelled++;
      await recordRecipientAudit(tx, { partnerId, phone, action: 'schedule.cancel', meta: { scheduleId: s.id, via: 'recipient_delete' } });
    }
    await createRecipientRepo(tx).tombstoneRecipient(partnerId, phone, recipient.recipientPhone);
    await recordRecipientAudit(tx, { partnerId, phone, action: 'recipient.delete', meta: { rid, schedulesCancelled: cancelled } });
    return { ok: true as const, schedulesCancelled: cancelled };
  });
}
