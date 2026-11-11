// Fix pack 4 (C6, R41): the payment code as an authorisation record.
//
// After a pay-step OTP verify, the route builds a PaymentAuthEvidence: which
// surface and route, which channel the code went out on, when it was issued,
// verified and on which attempt, and KEYED hashes of the client IP and
// user-agent. payloadHashFor names the exact figures the code approved.
//
// Every hash is an HMAC under an HKDF of the field-encryption master key
// (pattern: staff-auth-audit.ts deriveStaffIpKey), so the append-only audit
// row cannot confirm a guessed IP, name or last4 after the row is erased. A
// missing or undecodable key gives a null hash, never a refusal: a payment is
// never refused for a hash. Only ids and hashes leave this module; no raw IP,
// user-agent, name or last4.
//
// Pure apart from the env read of the default key; no I/O.
import { createHmac, hkdfSync } from 'node:crypto';
import { stableJson } from './ai-provenance';
import { env } from './env';
import { decodeMasterKey } from './field-crypto';
import { clientIpFrom } from './ip-rate-limit';
import type { VerifyResult } from './transaction-otp';
import type { Transfer } from './types';

export const PAY_OTP_IP_INFO = 'smartremit/pay-otp-ip/v1';
export const PAY_OTP_UA_INFO = 'smartremit/pay-otp-ua/v1';
export const PAY_PAYLOAD_INFO = 'smartremit/pay-payload/v1';
export const PAYLOAD_HASH_VERSION = 'ph1';

const UA_MAX = 512;

export interface PaymentAuthEvidence {
  surface: 'transfer' | 'link' | 'b2b';
  routeId: string;
  channel: 'wa' | 'tg' | null;
  issuedAt: number | null;
  verifiedAt: number;
  attempt: number | null;
  ipHash: string | null;
  uaHash: string | null;
}

function hmacKey(masterRaw: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', decodeMasterKey(masterRaw), '', info, 32));
}

function defaultMaster(): string | undefined {
  try {
    return env.fieldEncryptionKey;
  } catch {
    return undefined;
  }
}

/** HMAC-SHA256 hex (32 chars) of `value` under HKDF(master, info); null for an empty value or a missing / undecodable key. Never throws. */
export function payEvidenceHash(value: string, info: string, masterRaw: string | undefined): string | null {
  if (!value || !masterRaw) return null;
  try {
    return createHmac('sha256', hmacKey(masterRaw, info)).update(value).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

/** The authorisation record of one pay-step OTP verify (C6). Never throws for a missing key, IP or user-agent. */
export function buildPaymentAuthEvidence(i: {
  otp: Extract<VerifyResult, { ok: true }>;
  headers: Headers;
  surface: PaymentAuthEvidence['surface'];
  routeId: string;
  now: number;
  masterRaw?: string;
}): PaymentAuthEvidence {
  const master = i.masterRaw ?? defaultMaster();
  // A header read that throws only loses the hash (null), never the payment
  // (like enforceIpRateLimit's own guarded clientIpFrom read).
  let ip = '';
  try {
    const rawIp = clientIpFrom(i.headers);
    ip = rawIp === 'unknown' ? '' : rawIp;
  } catch {
    ip = '';
  }
  let ua = '';
  try {
    ua = (i.headers.get('user-agent') ?? '').slice(0, UA_MAX);
  } catch {
    ua = '';
  }
  return {
    surface: i.surface,
    routeId: i.routeId,
    channel: i.otp.channel ?? null,
    issuedAt: i.otp.issuedAt ?? null,
    verifiedAt: i.now,
    attempt: i.otp.attempt ?? null,
    ipHash: payEvidenceHash(ip, PAY_OTP_IP_INFO, master),
    uaHash: payEvidenceHash(ua, PAY_OTP_UA_INFO, master),
  };
}

/**
 * 'ph1:' + HMAC-SHA256 hex (full 64) of the figures the code approved, as
 * stableJson. The caller passes the LOCKED MASKED row: `payoutDestination` is
 * '****' + last4 (or ''), and only its last 4 characters are hashed; a
 * decrypted destination must never reach here. Null when the key is missing
 * or undecodable (never a refusal). Never throws.
 */
export function payloadHashFor(
  t: Pick<Transfer, 'id' | 'amountSource' | 'feeSource' | 'totalChargeSource' | 'sourceCurrency'
    | 'amountInr' | 'destinationCurrency' | 'fxRate' | 'recipientName' | 'payoutDestination'>,
  masterRaw?: string,
): string | null {
  try {
    const master = masterRaw ?? defaultMaster();
    if (!master) return null;
    const masked = t.payoutDestination ?? '';
    const payoutLast4 = masked.slice(-4);
    const json = stableJson({
      v: 1,
      id: t.id,
      amountSource: t.amountSource,
      feeSource: t.feeSource,
      totalChargeSource: t.totalChargeSource,
      sourceCurrency: t.sourceCurrency,
      amountDest: t.amountInr,
      destinationCurrency: t.destinationCurrency ?? 'INR',
      fxRate: t.fxRate,
      recipientName: t.recipientName,
      payoutLast4,
    });
    const digest = createHmac('sha256', hmacKey(master, PAY_PAYLOAD_INFO)).update(json).digest('hex');
    return `${PAYLOAD_HASH_VERSION}:${digest}`;
  } catch {
    return null;
  }
}
