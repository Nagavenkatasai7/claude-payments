import type { Db } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createReferralRepo, type ReferralPartnerStatus } from '@/db/repos/referral-repo';
import {
  generateReferralCode,
  newReferralPartnerId,
  normalizeReferralCode,
  parseCommissionUsd,
  parsePlumPortalUrl,
  parseReferralPartnerFields,
  parseStatementMonth,
  REFERRAL_CONTACT_MAX,
  type ReferralStatementLine,
} from './referrals';
import { NAME_MAX } from './untrusted-text';
import type { Staff } from './types';

// referral-admin — Batch B4. The service behind /admin-dashboard/referrals: every write is a
// PLATFORM-ADMIN-only action, validated here (the server action passes raw form fields) and
// written with its audit row in ONE transaction. Failures are a fixed set of codes, so the page
// shows only allowlisted text (a redirect's ?error= is attacker-controllable).

export const REFERRAL_ADMIN_ERRORS = {
  forbidden: 'Only a platform admin can manage referral partners.',
  name: `Name must be 1 to ${NAME_MAX} characters with no brackets or line breaks.`,
  contact: `Contact must be at most ${REFERRAL_CONTACT_MAX} characters on one line.`,
  commission: 'Commission must be a dollar amount from 0 to 1,000.00, such as 1.00.',
  status: 'Choose active or inactive.',
  not_found: 'That referral partner or code no longer exists.',
  code_format: 'A code is REF- followed by 6 letters or digits, such as REF-TANA01.',
  code_taken: 'That code is already in use. Choose another.',
  code_retry: 'A new code could not be generated. Try again.',
  url: 'Enter a full https:// address (at most 500 characters), or leave it empty to hide the link.',
} as const;

export type ReferralAdminErrorCode = keyof typeof REFERRAL_ADMIN_ERRORS;

export class ReferralAdminError extends Error {
  constructor(public readonly code: ReferralAdminErrorCode) {
    super(REFERRAL_ADMIN_ERRORS[code]);
    this.name = 'ReferralAdminError';
  }
}

export function isReferralAdminError(v: unknown): v is ReferralAdminErrorCode {
  return typeof v === 'string' && Object.hasOwn(REFERRAL_ADMIN_ERRORS, v);
}

type Actor = Pick<Staff, 'username' | 'role' | 'partnerId'>;

function assertPlatformAdmin(staff: Actor): void {
  if (staff.role !== 'admin' || staff.partnerId !== undefined) throw new ReferralAdminError('forbidden');
}

function partnerFields(input: { name: unknown; contact: unknown; commissionUsd: unknown }) {
  const f = parseReferralPartnerFields({ name: input.name, contact: input.contact });
  if (!f.ok) {
    // parseReferralPartnerFields checks the name first: an unclean name never reaches the contact.
    const nameOk = parseReferralPartnerFields({ name: input.name, contact: '' }).ok;
    throw new ReferralAdminError(nameOk ? 'contact' : 'name');
  }
  const c = parseCommissionUsd(input.commissionUsd);
  if (!c.ok) throw new ReferralAdminError('commission');
  return { name: f.name, contact: f.contact, commissionCents: c.cents };
}

const MINT_TRIES = 5;

/** Create a referral partner and its first (generated) code. */
export async function createReferralPartner(
  staff: Actor,
  input: { name: unknown; contact: unknown; commissionUsd: unknown },
  db: Db,
): Promise<{ id: string; code: string }> {
  assertPlatformAdmin(staff);
  const fields = partnerFields(input);
  const id = newReferralPartnerId();
  return db.transaction(async (tx) => {
    const repo = createReferralRepo(tx);
    await repo.insertPartner({ id, ...fields, createdBy: staff.username });
    const code = await mintCode(repo, id, staff.username);
    await createAuditRepo(tx).record({
      actor: staff.username,
      actorType: 'staff',
      action: 'referral.partner_create',
      subjectId: id,
      meta: { commissionCents: fields.commissionCents, code },
    });
    return { id, code };
  });
}

async function mintCode(repo: ReturnType<typeof createReferralRepo>, referralPartnerId: string, createdBy: string): Promise<string> {
  for (let i = 0; i < MINT_TRIES; i++) {
    const code = generateReferralCode();
    if (await repo.insertCode({ code, referralPartnerId, createdBy })) return code;
  }
  throw new ReferralAdminError('code_retry');
}

export async function updateReferralPartner(
  staff: Actor,
  id: string,
  input: { name: unknown; contact: unknown; commissionUsd: unknown; status: unknown },
  db: Db,
): Promise<void> {
  assertPlatformAdmin(staff);
  const fields = partnerFields(input);
  if (input.status !== 'active' && input.status !== 'inactive') throw new ReferralAdminError('status');
  const status: ReferralPartnerStatus = input.status;
  await db.transaction(async (tx) => {
    const repo = createReferralRepo(tx);
    const before = await repo.getPartner(id);
    if (!before) throw new ReferralAdminError('not_found');
    await repo.updatePartner(id, { ...fields, status });
    await createAuditRepo(tx).record({
      actor: staff.username,
      actorType: 'staff',
      action: 'referral.partner_update',
      subjectId: id,
      meta: { commissionCents: fields.commissionCents, previousCommissionCents: before.commissionCents, status, previousStatus: before.status },
    });
  });
}

/** Add a code: empty ⇒ generated; otherwise an admin-chosen code (REF- plus 6 letters or digits). */
export async function addReferralCode(staff: Actor, referralPartnerId: string, rawCode: unknown, db: Db): Promise<string> {
  assertPlatformAdmin(staff);
  const wanted = typeof rawCode === 'string' && rawCode.trim() !== '' ? normalizeReferralCode(rawCode) : undefined;
  if (wanted === null) throw new ReferralAdminError('code_format');
  return db.transaction(async (tx) => {
    const repo = createReferralRepo(tx);
    if (!(await repo.getPartner(referralPartnerId))) throw new ReferralAdminError('not_found');
    let code: string;
    if (wanted) {
      if (!(await repo.insertCode({ code: wanted, referralPartnerId, createdBy: staff.username }))) throw new ReferralAdminError('code_taken');
      code = wanted;
    } else {
      code = await mintCode(repo, referralPartnerId, staff.username);
    }
    await createAuditRepo(tx).record({
      actor: staff.username,
      actorType: 'staff',
      action: 'referral.code_add',
      subjectId: code,
      meta: { referralPartnerId },
    });
    return code;
  });
}

/** Turn a code off (a leaked code) or back on. Existing attributions stay. */
export async function setReferralCodeActive(staff: Actor, rawCode: unknown, enabled: unknown, db: Db): Promise<void> {
  assertPlatformAdmin(staff);
  const code = normalizeReferralCode(rawCode);
  if (!code) throw new ReferralAdminError('not_found');
  const active = enabled === 'on';
  await db.transaction(async (tx) => {
    if (!(await createReferralRepo(tx).setCodeActive(code, active))) throw new ReferralAdminError('not_found');
    await createAuditRepo(tx).record({
      actor: staff.username,
      actorType: 'staff',
      action: 'referral.code_update',
      subjectId: code,
      meta: { active },
    });
  });
}

/** The "Referral rewards" (Plum) portal address. Empty clears it and hides the public link. */
export async function setReferralPlumUrl(staff: Actor, raw: unknown, db: Db): Promise<void> {
  assertPlatformAdmin(staff);
  const parsed = parsePlumPortalUrl(raw);
  if (!parsed.ok) throw new ReferralAdminError('url');
  await db.transaction(async (tx) => {
    await createReferralRepo(tx).setPlumPortalUrl(parsed.url, staff.username);
    await createAuditRepo(tx).record({
      actor: staff.username,
      actorType: 'staff',
      action: 'referral.settings_update',
      subjectId: 'plum_portal_url',
      // The host only: a Plum address may carry a token in its query.
      meta: { plumPortalHost: parsed.url ? new URL(parsed.url).hostname : null },
    });
  });
}

export interface ReferralStatement {
  month: string;
  lines: Array<ReferralStatementLine & { referralPartnerId: string; status: ReferralPartnerStatus }>;
  totalCents: number;
}

/** The monthly statement for the page and the CSV (a read; no audit here). */
export async function buildReferralStatement(db: Db, rawMonth: unknown, now: Date): Promise<ReferralStatement> {
  const { month, from, to } = parseStatementMonth(rawMonth, now);
  const rows = await createReferralRepo(db).monthlyStatement(from, to);
  const lines = rows.map((r) => ({
    referralPartnerId: r.referralPartnerId,
    status: r.status,
    name: r.name,
    contact: r.contact,
    deliveredCount: r.deliveredCount,
    commissionCents: r.commissionCents,
  }));
  return { month, lines, totalCents: lines.reduce((s, l) => s + l.deliveredCount * l.commissionCents, 0) };
}
