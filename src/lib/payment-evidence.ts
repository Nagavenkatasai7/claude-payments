// Fix pack 4 (C7): the evidence of one pay request.
// Built once per pay request after the OTP verify (C7); committed by
// commitPaymentEvidence (T8, C8); never passed into settlement.ts.
// Types only: ids and hashes, never a phone, raw IP, user-agent, code or name.
import type { PaymentAuthEvidence } from './payment-auth-evidence';

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
