// Fix pack 4 (C7, C8): the evidence of one pay request, and its commit.
// Built once per pay request after the OTP verify (C7); committed by
// commitPaymentEvidence ("authorise, then capture", C8) BEFORE any charge;
// never passed into settlement.ts.
// Ids and hashes only: never a phone, raw IP, user-agent, code or name.
import type { Db } from '@/db/client';
import { createAuditRepo, type AuditEvent } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { logWarn } from './log';
import type { ResolvedDisclosure } from './partner-config';
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

export interface PaymentEvidence {
  disclosureAck: DisclosureAckEvidence | null;
  disclosureSnapshot: DisclosureSnapshotInput | null;
  auth: PaymentAuthEvidence | null;
}

export type EvidenceCommitResult = { kind: 'written' } | { kind: 'not_awaiting' } | { kind: 'nothing' };

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
 */
export async function commitPaymentEvidence(
  db: Db,
  t: Transfer,
  ev: PaymentEvidence,
  disclosure: ResolvedDisclosure | null,
  now: number = Date.now(),
): Promise<EvidenceCommitResult> {
  if (!ev.auth && !ev.disclosureAck) return { kind: 'nothing' };
  return db.transaction(async (tx): Promise<EvidenceCommitResult> => {
    const repo = createTransferRepo(tx);
    const locked = await repo.getTransferForUpdate(t.id, { partnerId: t.partnerId });
    if (!locked || locked.status !== 'awaiting_payment') return { kind: 'not_awaiting' };
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
    await createAuditRepo(tx).recordMany(rows);
    if (ev.disclosureAck && ev.disclosureSnapshot && disclosure) {
      const snap = buildDisclosureSnapshot({ transfer: locked, disclosure, input: ev.disclosureSnapshot, now });
      if (!(await repo.setDisclosureSnapshotIfAwaiting(locked.id, locked.partnerId, snap))) {
        throw new Error('disclosure_snapshot_not_written');
      }
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
