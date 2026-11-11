// helpers-pay-evidence — Fix pack 4 T8 (C24): pay-step evidence fixtures.
//
//   okVerify(o?)         a successful OTP verify (issued 60 s ago, attempt 1, WhatsApp)
//   realMoneyPayBody(o?) the pay body a real-money payment posts (code, ack version,
//                        account-holder name, the sender's address and date of
//                        birth (fix pack 5; `originator: false` drops both); the
//                        shown hash only when given)
//   testEvidence(o?)     a PaymentEvidence (auth + ack + snapshot input; `ack: false`
//                        drops the ack and the snapshot; `esignVersion` adds the
//                        E-SIGN consent (fix pack 6 P6), absent otherwise)
//
// Times are relative to now (never hardcoded: CLAUDE.md test fixtures rule).
// Hashes are null: a test that is about the hashes builds them itself.
import { DISCLOSURE_DRAFT_VERSION } from '@/lib/legal/disclosure-drafts';
import type { PaymentAuthEvidence } from '@/lib/payment-auth-evidence';
import type { PaymentEvidence } from '@/lib/payment-evidence';
import type { VerifyResult } from '@/lib/transaction-otp';

type OkVerify = Extract<VerifyResult, { ok: true }>;

export function okVerify(o: Partial<Omit<OkVerify, 'ok'>> = {}): OkVerify {
  return { ok: true, issuedAt: Date.now() - 60_000, attempt: 1, channel: 'wa', ...o };
}

export function realMoneyPayBody(
  o: {
    otp?: string;
    disclosureHash?: string;
    accountHolder?: string;
    senderAddress?: string;
    senderDob?: string;
    /** Fix pack 5 T21a: false drops both originator keys (an old tab). */
    originator?: false;
  } = {},
): {
  otp: string;
  disclosureVersion: string;
  accountHolder: string;
  senderAddress?: string;
  senderDob?: string;
  disclosureHash?: string;
} {
  // Fix pack 5 T21a (P32): an invented one-line address and a date of birth 40
  // years before now (computed, never a fixed date), both valid for P18.
  const dob40 = new Date(Date.now() - 40 * 365.25 * 86_400_000).toISOString().slice(0, 10);
  return {
    otp: o.otp ?? '654321',
    disclosureVersion: DISCLOSURE_DRAFT_VERSION,
    accountHolder: o.accountHolder ?? 'Anita Legal',
    ...(o.originator === false
      ? {}
      : { senderAddress: o.senderAddress ?? '1 Fixture Road, Testtown 00000', senderDob: o.senderDob ?? dob40 }),
    ...(o.disclosureHash ? { disclosureHash: o.disclosureHash } : {}),
  };
}

export function testEvidence(
  o: {
    routeId?: string;
    shownHash?: string | null;
    ack?: boolean;
    surface?: PaymentAuthEvidence['surface'];
    /** Fix pack 6 (P6): adds `esignConsent: { version, routeId }`; absent when not given. */
    esignVersion?: string;
  } = {},
): PaymentEvidence {
  const now = Date.now();
  const routeId = o.routeId ?? 'tx_test_evidence';
  const shownHash = o.shownHash ?? null;
  const auth: PaymentAuthEvidence = {
    surface: o.surface ?? 'transfer',
    routeId,
    channel: 'wa',
    issuedAt: now - 60_000,
    verifiedAt: now,
    attempt: 1,
    ipHash: null,
    uaHash: null,
  };
  const esign = o.esignVersion !== undefined ? { esignConsent: { version: o.esignVersion, routeId } } : {};
  if (o.ack === false) return { auth, disclosureAck: null, disclosureSnapshot: null, ...esign };
  return {
    auth,
    disclosureAck: { version: DISCLOSURE_DRAFT_VERSION, shownHash, routeId },
    disclosureSnapshot: { surface: o.surface === 'link' ? 'link' : 'transfer', version: DISCLOSURE_DRAFT_VERSION, shownHash, acknowledgedAt: now },
    ...esign,
  };
}
