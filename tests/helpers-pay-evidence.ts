// helpers-pay-evidence — Fix pack 4 T8 (C24): pay-step evidence fixtures.
//
//   okVerify(o?)         a successful OTP verify (issued 60 s ago, attempt 1, WhatsApp)
//   realMoneyPayBody(o?) the pay body a real-money payment posts (code, ack version,
//                        account-holder name; the shown hash only when given)
//   testEvidence(o?)     a PaymentEvidence (auth + ack + snapshot input; `ack: false`
//                        drops the ack and the snapshot)
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

export function realMoneyPayBody(o: { otp?: string; disclosureHash?: string; accountHolder?: string } = {}): {
  otp: string;
  disclosureVersion: string;
  accountHolder: string;
  disclosureHash?: string;
} {
  return {
    otp: o.otp ?? '654321',
    disclosureVersion: DISCLOSURE_DRAFT_VERSION,
    accountHolder: o.accountHolder ?? 'Anita Legal',
    ...(o.disclosureHash ? { disclosureHash: o.disclosureHash } : {}),
  };
}

export function testEvidence(
  o: { routeId?: string; shownHash?: string | null; ack?: boolean; surface?: PaymentAuthEvidence['surface'] } = {},
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
  if (o.ack === false) return { auth, disclosureAck: null, disclosureSnapshot: null };
  return {
    auth,
    disclosureAck: { version: DISCLOSURE_DRAFT_VERSION, shownHash, routeId },
    disclosureSnapshot: { surface: o.surface === 'link' ? 'link' : 'transfer', version: DISCLOSURE_DRAFT_VERSION, shownHash, acknowledgedAt: now },
  };
}
