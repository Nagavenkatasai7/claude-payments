import { randomBytes } from 'node:crypto';
import type { Db } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createPayeeRepo, type Payee, type PayeeBankDetails } from '@/db/repos/payee-repo';
import { createPaymentLinkRepo, type PaymentLink } from '@/db/repos/payment-link-repo';
import { createPartnerStore } from './partner-store';
import { resolveCorridorRules } from './compliance-config';
import { sanctionsAuditEvent } from './sanctions/evidence';
import { nextPayeeStatus, parsePayeeInput, screenPayee, type PayeeDecision, type PayeeRawField } from './payees';
import { linkExpiresAt, newLinkToken, parseLinkInput, type LinkField, type LinkRaw } from './payment-links';
import { buildBulkReport, type BulkReport } from './payment-link-bulk';
import type { PartnerId } from './types';

// payment-link-ops — Batch B2. The service behind the partner pages (payees,
// payment links) and the platform admin's payee queue. Server actions are public
// POST endpoints: each one gates (refuseOnSiteHost + require*) and then calls
// here with the SESSION's tenant and actor, never a tenant from the form. Every
// function re-checks the actor's role, validates every field, reads its target
// under that tenant (another tenant's id is "not found"), and writes the change
// and its audit row in ONE transaction. Audit meta carries ids and counts only,
// never a name, a phone or a bank detail.

export type OpsErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'refused'
  | 'review'
  | 'not_allowed'
  | 'payee_not_approved'
  | 'duplicate_reference'
  | 'bad_file'
  | 'nothing_to_create';

export class PaymentLinkOpsError extends Error {
  constructor(
    readonly code: OpsErrorCode,
    readonly fieldErrors: Partial<Record<string, string>> = {},
  ) {
    super(code);
    this.name = 'PaymentLinkOpsError';
  }
}

/** The partner side: a partner ADMIN of exactly one tenant. */
export interface PartnerActor {
  partnerId: PartnerId;
  username: string;
  role: string;
}

/** The platform side: a SmartRemit admin with no tenant. */
export interface PlatformActor {
  username: string;
  role: string;
  partnerId?: string;
}

function assertPartnerAdmin(a: PartnerActor): void {
  if (a.role !== 'admin' || !a.partnerId) throw new PaymentLinkOpsError('forbidden');
}

function assertPlatformAdmin(a: PlatformActor): void {
  if (a.role !== 'admin' || a.partnerId !== undefined) throw new PaymentLinkOpsError('forbidden');
}

async function rulesFor(db: Db, partnerId: PartnerId) {
  return resolveCorridorRules(await createPartnerStore(db).getPartner(partnerId), 'US');
}

const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`;

// ── Payees ──────────────────────────────────────────────────────────────────

/**
 * The partner adds a company. Both names are screened first: a full match is
 * refused and NOT saved (an audit row records the refusal, ids only); a
 * possible match is saved with screening 'review', which an admin cannot approve.
 */
export async function addPayee(
  db: Db,
  actor: PartnerActor,
  raw: Partial<Record<PayeeRawField, unknown>>,
): Promise<Payee> {
  assertPartnerAdmin(actor);
  const parsed = parsePayeeInput(raw);
  if (!parsed.ok) throw new PaymentLinkOpsError('invalid', parsed.errors);
  const id = newId('pye');
  const screen = await screenPayee(
    { legalName: parsed.value.legalName, accountHolder: parsed.value.accountHolder },
    await rulesFor(db, actor.partnerId),
  );
  if (screen.verdict === 'match') {
    await db.transaction(async (tx) => {
      const audit = createAuditRepo(tx);
      if (screen.evidence) await audit.record(sanctionsAuditEvent(actor.partnerId, id, screen.evidence));
      await audit.record({
        partnerId: actor.partnerId, actor: actor.username, actorType: 'staff', action: 'payee.refused', subjectId: id,
      });
    });
    throw new PaymentLinkOpsError('refused');
  }
  const screening = screen.verdict; // 'clear' | 'review' here
  await db.transaction(async (tx) => {
    await createPayeeRepo(tx).insert({
      id,
      partnerId: actor.partnerId,
      legalName: parsed.value.legalName,
      accountHolder: parsed.value.accountHolder,
      payoutDestination: parsed.value.payoutDestination,
      last4: parsed.value.last4,
      screening,
      createdBy: actor.username,
    });
    const audit = createAuditRepo(tx);
    if (screen.evidence) await audit.record(sanctionsAuditEvent(actor.partnerId, id, screen.evidence));
    await audit.record({
      partnerId: actor.partnerId, actor: actor.username, actorType: 'staff', action: 'payee.create', subjectId: id,
      meta: { screening },
    });
  });
  const payee = await createPayeeRepo(db).getForPartner(actor.partnerId, id);
  if (!payee) throw new PaymentLinkOpsError('not_found');
  return payee;
}

/**
 * A platform admin approves, rejects or suspends a payee. Approve re-screens
 * both names: a match rejects it, a possible match refuses the approval (the
 * row keeps 'review'). One guarded UPDATE: a concurrent decision makes it fail.
 */
export async function decidePayee(
  db: Db,
  actor: PlatformActor,
  payeeId: string,
  decision: PayeeDecision,
): Promise<Payee> {
  assertPlatformAdmin(actor);
  if (decision !== 'approve' && decision !== 'reject' && decision !== 'suspend') throw new PaymentLinkOpsError('invalid');
  const repo = createPayeeRepo(db);
  const payee = await repo.getById(payeeId);
  if (!payee) throw new PaymentLinkOpsError('not_found');
  let to = nextPayeeStatus(payee.status, decision);
  if (!to) throw new PaymentLinkOpsError('not_allowed');

  let screening: Payee['screening'] | undefined;
  let refusedByScreen = false;
  if (decision === 'approve') {
    const bank = await repo.getBankDetails(payee.id);
    if (!bank) throw new PaymentLinkOpsError('not_found');
    const screen = await screenPayee(
      { legalName: payee.legalName, accountHolder: bank.accountHolder },
      await rulesFor(db, payee.partnerId),
    );
    if (screen.evidence) await createAuditRepo(db).record(sanctionsAuditEvent(payee.partnerId, payee.id, screen.evidence));
    if (screen.verdict === 'review') {
      await repo.setScreening(payee.id, 'review');
      throw new PaymentLinkOpsError('review');
    }
    if (screen.verdict === 'match') {
      to = 'rejected';
      refusedByScreen = true;
    } else {
      screening = 'clear';
    }
  }

  const decided = await db.transaction(async (tx) => {
    const row = await createPayeeRepo(tx).decide(payee.id, [payee.status], to, actor.username, screening);
    if (!row) return null;
    await createAuditRepo(tx).record({
      partnerId: payee.partnerId, actor: actor.username, actorType: 'staff', action: 'payee.decide', subjectId: payee.id,
      meta: { decision, from: payee.status, to, ...(refusedByScreen ? { screen: 'match' } : {}) },
    });
    return row;
  });
  if (!decided) throw new PaymentLinkOpsError('not_allowed');
  if (refusedByScreen) throw new PaymentLinkOpsError('refused');
  return decided;
}

/** The audited reveal of a payee's bank details (platform admin only): one `pii.reveal` row per call. */
export async function revealPayeeBank(db: Db, actor: PlatformActor, payeeId: string): Promise<PayeeBankDetails> {
  assertPlatformAdmin(actor);
  const bank = await createPayeeRepo(db).getBankDetails(payeeId);
  if (!bank) throw new PaymentLinkOpsError('not_found');
  await createAuditRepo(db).record({
    partnerId: bank.partnerId, actor: actor.username, actorType: 'staff', action: 'pii.reveal', subjectId: payeeId,
    meta: { field: 'payee_bank_details' },
  });
  return { accountHolder: bank.accountHolder, payoutDestination: bank.payoutDestination };
}

// ── Links ───────────────────────────────────────────────────────────────────

async function approvedPayeeOf(db: Db, partnerId: PartnerId, payeeId: string): Promise<Payee> {
  const payee = typeof payeeId === 'string' && payeeId !== '' ? await createPayeeRepo(db).getForPartner(partnerId, payeeId) : null;
  if (!payee) throw new PaymentLinkOpsError('not_found');
  if (payee.status !== 'approved' || payee.screening !== 'clear') throw new PaymentLinkOpsError('payee_not_approved');
  return payee;
}

export interface CreatedLink {
  id: string;
  token: string;
  reference: string;
}

/** One link for one customer, to an APPROVED payee of the actor's own tenant. */
export async function createLink(
  db: Db,
  actor: PartnerActor,
  input: { payeeId: string; raw: LinkRaw; usdPerInr?: number; now?: Date },
): Promise<CreatedLink & { warnings: string[] }> {
  assertPartnerAdmin(actor);
  const payee = await approvedPayeeOf(db, actor.partnerId, input.payeeId);
  const parsed = parseLinkInput(input.raw, { usdPerInr: input.usdPerInr });
  if (!parsed.ok) throw new PaymentLinkOpsError('invalid', parsed.errors as Partial<Record<LinkField, string>>);
  const v = parsed.value;
  const link: CreatedLink = { id: newId('pl'), token: newLinkToken(), reference: v.reference };
  await db.transaction(async (tx) => {
    const created = await createPaymentLinkRepo(tx).insertLinks([{
      id: link.id, partnerId: actor.partnerId, payeeId: payee.id, token: link.token, reference: v.reference,
      customerName: v.customerName, customerPhone: v.customerPhone, amountInr: v.amountInr, purpose: v.purpose,
      expiresAt: linkExpiresAt(input.now), createdBy: actor.username,
    }]);
    if (created.length === 0) throw new PaymentLinkOpsError('duplicate_reference', { reference: 'You already have a link with this reference.' });
    await createAuditRepo(tx).record({
      partnerId: actor.partnerId, actor: actor.username, actorType: 'staff', action: 'paylink.create', subjectId: link.id,
      meta: { payeeId: payee.id },
    });
  });
  return { ...link, warnings: parsed.warnings };
}

/** The row-by-row report of a CSV upload against this tenant's existing references. Saves nothing. */
export async function checkBulk(
  db: Db,
  actor: PartnerActor,
  input: { text: string; usdPerInr?: number },
): Promise<BulkReport> {
  assertPartnerAdmin(actor);
  const first = buildBulkReport(input.text, { existingReferences: new Set(), usdPerInr: input.usdPerInr });
  if (!first.ok) return first;
  const refs = [...new Set(first.rows.map((r) => r.cells.reference).filter((r) => r !== ''))];
  const existing = await createPaymentLinkRepo(db).existingReferences(actor.partnerId, refs);
  return buildBulkReport(input.text, { existingReferences: existing, usdPerInr: input.usdPerInr });
}

/**
 * Create the links of an upload the partner confirmed. The SAME check runs
 * again on the same text (the browser's copy of the report is never trusted);
 * rows with errors are skipped, as the report said they would be.
 */
export async function createBulk(
  db: Db,
  actor: PartnerActor,
  input: { payeeId: string; text: string; usdPerInr?: number; now?: Date },
): Promise<{ created: CreatedLink[]; skipped: number }> {
  assertPartnerAdmin(actor);
  const payee = await approvedPayeeOf(db, actor.partnerId, input.payeeId);
  const report = await checkBulk(db, actor, { text: input.text, usdPerInr: input.usdPerInr });
  if (!report.ok) throw new PaymentLinkOpsError('bad_file', { file: report.error });
  const valid = report.rows.filter((r) => r.ok && r.value);
  if (valid.length === 0) throw new PaymentLinkOpsError('nothing_to_create');
  const expiresAt = linkExpiresAt(input.now);
  const planned = valid.map((r) => ({ id: newId('pl'), token: newLinkToken(), value: r.value! }));
  const createdRefs = await db.transaction(async (tx) => {
    const refs = await createPaymentLinkRepo(tx).insertLinks(
      planned.map((p) => ({
        id: p.id, partnerId: actor.partnerId, payeeId: payee.id, token: p.token, reference: p.value.reference,
        customerName: p.value.customerName, customerPhone: p.value.customerPhone, amountInr: p.value.amountInr,
        purpose: p.value.purpose, expiresAt, createdBy: actor.username,
      })),
    );
    await createAuditRepo(tx).record({
      partnerId: actor.partnerId, actor: actor.username, actorType: 'staff', action: 'paylink.bulk_create',
      subjectId: payee.id, meta: { created: refs.length, skipped: report.rows.length - refs.length },
    });
    return new Set(refs);
  });
  const created = planned
    .filter((p) => createdRefs.has(p.value.reference))
    .map((p) => ({ id: p.id, token: p.token, reference: p.value.reference }));
  return { created, skipped: report.rows.length - created.length };
}

/** The partner cancels an OPEN link (a paid, cancelled or expired one cannot be). */
export async function cancelLink(db: Db, actor: PartnerActor, linkId: string): Promise<void> {
  assertPartnerAdmin(actor);
  const link: PaymentLink | null =
    typeof linkId === 'string' && linkId !== '' ? await createPaymentLinkRepo(db).getForPartner(actor.partnerId, linkId) : null;
  if (!link) throw new PaymentLinkOpsError('not_found');
  const ok = await db.transaction(async (tx) => {
    if (!(await createPaymentLinkRepo(tx).cancel(actor.partnerId, link.id, actor.username))) return false;
    await createAuditRepo(tx).record({
      partnerId: actor.partnerId, actor: actor.username, actorType: 'staff', action: 'paylink.cancel', subjectId: link.id,
    });
    return true;
  });
  if (!ok) throw new PaymentLinkOpsError('not_allowed');
}
