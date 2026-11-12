// Fix pack 4 (C7, C8): the evidence of one pay request, and its commit.
// Built once per pay request after the OTP verify (C7); committed by
// commitPaymentEvidence ("authorise, then capture", C8) BEFORE any charge;
// never passed into settlement.ts.
// Ids and hashes only: never a phone, raw IP, user-agent, code or name.
import type { Db } from '@/db/client';
import { createAuditRepo, type AuditEvent } from '@/db/repos/aux-repos';
import { createCustomerRepo, recordEsignConsent } from '@/db/repos/customer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { auditSubjectId } from './customer-ref';
import { DEFAULT_PARTNER_ID } from './defaults';
import { logWarn } from './log';
import { resolvePartnerDisclosure, type ResolvedDisclosure } from './partner-config';
import { disclosureGateRefusal, type DisclosureGateRefusal } from './pay-disclosure-gate';
import { transferFunded } from './pay-not-available';
import { payloadHashFor, type PaymentAuthEvidence } from './payment-auth-evidence';
import { buildDisclosureSnapshot, disclosureProviderKind } from './remittance-disclosure';
import type { Transfer } from './types';

export interface DisclosureAckEvidence {
  version: string;
  shownHash: string | null;
  routeId: string;
}

export interface DisclosureSnapshotInput {
  surface: 'transfer' | 'link';
  version: string;
  shownHash: string | null;
  acknowledgedAt: number;
}

/** Fix pack 6 (P6): the E-SIGN consent the customer ticked (a current version, checked by the caller's gate). */
export interface EsignConsentEvidence {
  version: string;
  routeId: string;
}

export interface PaymentEvidence {
  disclosureAck: DisclosureAckEvidence | null;
  disclosureSnapshot: DisclosureSnapshotInput | null;
  auth: PaymentAuthEvidence | null;
  /** Fix pack 6 (P6): optional; absent or null writes no consent and touches no customers row. */
  esignConsent?: EsignConsentEvidence | null;
}

export type EvidenceCommitResult =
  | { kind: 'written' }
  | { kind: 'not_awaiting' }
  | { kind: 'nothing' }
  // Review R1-P3 C2: a mandatory payment whose R18 gate no longer passes on the
  // owner row read under the lock. Nothing was written; a correct refusal, not a
  // write failure (no payevidence alert). `funded` is the LOCKED row's funded
  // state (review round 2 M3): a parallel attempt may have bound a debit since
  // the caller's read, so the refusal copy must not say "Nothing was charged".
  | { kind: 'refused'; refusal: DisclosureGateRefusal; funded: boolean };

export interface EvidenceCommitOptions {
  /** The caller's R18 decision (disclosureMandatory). True re-checks the gate under the owner lock. */
  mandatory?: boolean;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * C8: commit the customer's evidence in ONE transaction on the LOCKED
 * awaiting_payment row (tenant-scoped FOR UPDATE), before any charge:
 * the `otp.verified` row (when `ev.auth`), the `remittance.disclosure_ack`
 * row (when `ev.disclosureAck`), both in one INSERT, and the disclosure
 * snapshot of the locked row (when ack, snapshot input and a disclosure are
 * all present). A row that is gone, another tenant's or no longer awaiting
 * payment writes nothing (`not_awaiting`). A DB error THROWS (rolled back):
 * the caller refuses the charge. No logging here (the caller logs the error
 * name). The audit partner is the OWNER from the locked row (C0 rule 4).
 *
 * Review R1-P3 C2: when `opts.mandatory`, the OWNER partner row is read again
 * inside this transaction under FOR SHARE (lock order: transfer row, then
 * partner row; it waits on setDisclosure's FOR UPDATE and blocks the next save
 * until this commit), the disclosure is resolved from that read, and the same
 * R18 gate (disclosureGateRefusal) runs on it: a refusal returns `refused`
 * BEFORE anything is written. The ack's provider kind and the snapshot are then
 * built from the locked read, never the caller's copy. A payment that is not
 * mandatory takes no partner lock and uses the caller's `disclosure` as before.
 *
 * Fix pack 6 (P6, P21, critic C10): when `ev.esignConsent`, the same INSERT
 * also carries the `customer.consent.esign` row (subject the transfer id, meta
 * `{ version, surface, on: true, routeId, customerRef }`, customerRef the keyed
 * `auditSubjectId` of the owner and sender, never the phone), and after the
 * snapshot the OWNER's customers row `(locked.partnerId, locked.phone)` records
 * the version at `now` (lock order: transfer row, partner row FOR SHARE when
 * mandatory, customers row). A missing customers row (a legacy or never-inbound
 * sender) is created with ensureCustomer (no opt-in, firstSeenAt by the
 * first-transfer rule) and the write retried ONCE; a second miss throws
 * `esign_consent_not_written` (rolled back: the caller answers 503
 * approval_not_recorded, nothing charged). The consent is not part of the
 * disclosure snapshot (v1 unchanged). Without `ev.esignConsent` no customers
 * SQL runs at all.
 */
export async function commitPaymentEvidence(
  db: Db,
  t: Transfer,
  ev: PaymentEvidence,
  callerDisclosure: ResolvedDisclosure | null,
  now: number = Date.now(),
  opts: EvidenceCommitOptions = {},
): Promise<EvidenceCommitResult> {
  if (!ev.auth && !ev.disclosureAck && !ev.esignConsent) return { kind: 'nothing' };
  return db.transaction(async (tx): Promise<EvidenceCommitResult> => {
    const repo = createTransferRepo(tx);
    const locked = await repo.getTransferForUpdate(t.id, { partnerId: t.partnerId });
    if (!locked || locked.status !== 'awaiting_payment') return { kind: 'not_awaiting' };
    let disclosure = callerDisclosure;
    if (opts.mandatory) {
      // The default tenant's block is the demo block (pay-process makes no read for it either).
      disclosure =
        locked.partnerId === DEFAULT_PARTNER_ID
          ? resolvePartnerDisclosure(null)
          : resolvePartnerDisclosure(await createPartnerRepo(tx).getPartnerForShare(locked.partnerId));
      const refusal = disclosureGateRefusal({
        mandatory: true,
        disclosure,
        ackVersion: ev.disclosureAck?.version ?? null,
        postedHash: ev.disclosureAck?.shownHash ?? null,
      });
      if (refusal) return { kind: 'refused', refusal, funded: transferFunded(locked) };
    }
    const rows: AuditEvent[] = [];
    if (ev.auth) {
      const a = ev.auth;
      rows.push({
        partnerId: locked.partnerId,
        actor: 'pay-page',
        actorType: 'system',
        action: 'otp.verified',
        subjectId: locked.id,
        meta: {
          surface: a.surface,
          channel: a.channel,
          issuedAt: iso(a.issuedAt),
          verifiedAt: iso(a.verifiedAt),
          attempt: a.attempt,
          ipHash: a.ipHash,
          uaHash: a.uaHash,
          disclosureVersion: ev.disclosureAck?.version ?? null,
          payloadHash: payloadHashFor(locked),
          routeId: a.routeId,
        },
      });
    }
    if (ev.disclosureAck) {
      const k = ev.disclosureAck;
      rows.push({
        partnerId: locked.partnerId,
        actor: 'pay-page',
        actorType: 'system',
        action: 'remittance.disclosure_ack',
        subjectId: locked.id,
        meta: {
          version: k.version,
          providerKind: disclosure ? disclosureProviderKind(disclosure) : null,
          shownHash: k.shownHash,
          routeId: k.routeId,
        },
      });
    }
    if (ev.esignConsent) {
      const c = ev.esignConsent;
      rows.push({
        partnerId: locked.partnerId,
        actor: 'pay-page',
        actorType: 'system',
        action: 'customer.consent.esign',
        subjectId: locked.id,
        meta: {
          version: c.version,
          surface: ev.auth?.surface ?? 'transfer',
          on: true,
          routeId: c.routeId,
          customerRef: auditSubjectId(locked.partnerId, locked.phone),
        },
      });
    }
    await createAuditRepo(tx).recordMany(rows);
    if (ev.disclosureAck && ev.disclosureSnapshot && disclosure) {
      const snap = buildDisclosureSnapshot({ transfer: locked, disclosure, input: ev.disclosureSnapshot, now });
      if (!(await repo.setDisclosureSnapshotIfAwaiting(locked.id, locked.partnerId, snap))) {
        throw new Error('disclosure_snapshot_not_written');
      }
    }
    if (ev.esignConsent) {
      const { version } = ev.esignConsent;
      const at = new Date(now);
      let ok = await recordEsignConsent(tx, locked.partnerId, locked.phone, version, at);
      if (!ok) {
        // Critic C10: no customers row for this sender yet; create it (no opt-in) and retry once.
        await createCustomerRepo(tx, (p, ph) => createTransferRepo(tx).firstTransferAt(p, ph)).ensureCustomer(
          locked.partnerId,
          locked.phone,
        );
        ok = await recordEsignConsent(tx, locked.partnerId, locked.phone, version, at);
      }
      if (!ok) throw new Error('esign_consent_not_written');
    }
    return { kind: 'written' };
  });
}

/**
 * C8 (critic M9): one deduped ops alert per hour when a pay-page payment was
 * refused because its evidence could not be written. Names only the surface.
 * Best-effort: its own failure is logged by error name and swallowed.
 * Callers poke the worker (pay-process.ts; the B2B route, T10).
 */
export async function alertPayEvidenceUnavailable(
  db: Db,
  surface: 'transfer' | 'link' | 'b2b',
  now: number = Date.now(),
): Promise<void> {
  try {
    await createOutboxRepo(db).enqueue(
      'ops.alert',
      {
        message: `⚠️ SmartRemit ops: a pay-page payment (${surface}) was refused because its approval record could not be written; nothing was charged. Repeated failures can use up a payment's 10-code budget (8-day lock).`,
      },
      { dedupeKey: `payevidence:${new Date(now).toISOString().slice(0, 13)}` },
    );
  } catch (err) {
    logWarn('pay.evidence-alert', err instanceof Error ? err.name : 'error', {});
  }
}
