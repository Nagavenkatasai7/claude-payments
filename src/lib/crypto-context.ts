import type { CryptoContext } from '@/lib/field-crypto';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { PartnerId } from '@/lib/types';

// crypto-context (Program-Fix 46A) — THE place a field-crypto storage context is
// built. A v2 blob binds `aadFor(ctx)` (field-crypto.ts) into its GCM tag, so it
// opens only in the exact (table, column, row) it was sealed for.
//
// Rules the call sites follow:
//  - READS build the context from the FETCHED ROW's own key columns, never from
//    the caller's arguments.
//  - WRITES build it from the row's key columns AS WRITTEN (the insert/update
//    values, after customerToRow / transferToRow), through the SAME per-table
//    helper, so the two sides cannot drift.
//  - The output strings are a storage format, pinned by
//    tests/crypto-context.test.ts. Changing one orphans every v2 row sealed
//    under it.
//
// Builders are pure and NEVER throw: a v1 blob ignores the context, so a legacy
// row with an odd key must keep opening exactly as before. Validation happens
// only inside field-crypto's v2 paths.

export type TransferEncColumn =
  | 'payout_destination_enc'
  | 'recipient_legal_name_enc'
  | 'sender_business_name_enc'
  | 'recipient_business_name_enc';

export type CustomerEncColumn =
  | 'full_name_enc'
  | 'date_of_birth_enc'
  | 'residential_address_enc'
  | 'gov_id_number_enc'
  | 'email_enc'
  // Program-Fix 49D: the portal TOTP secret. Sealed and opened ONLY by
  // customer-repo's MFA methods, under customerRowCtx(row, 'mfa_totp_enc').
  | 'mfa_totp_enc';

export type IntegrationEncColumn =
  | 'kyc_api_key_enc'
  | 'kyc_webhook_secret_enc'
  | 'payment_credentials_enc'
  | 'payment_webhook_secret_enc'
  | 'wa_token_enc'
  | 'wa_verify_token_enc'
  | 'wa_app_secret_enc'
  | 'funding_credentials_enc'; // Program-Fix 7

export type WaitlistEncColumn = 'full_name_enc' | 'email_enc' | 'phone_enc' | 'location_enc';

/**
 * Purpose contexts: values that live outside a table row. `customer_ref` is a
 * short-lived URL token; `outbox.apply_link` is the sealed invite link in an
 * `email.send` outbox payload.
 */
export type CryptoPurpose = 'customer_ref' | 'outbox.apply_link';

/**
 * Purposes that keep reading v1 permanently, even once 46B's reject-v1 switch
 * is on: `customer_ref` (openCustomerRef checks its own `cref1|` plaintext
 * prefix) and `staff_mfa` (refusing it could lock out an enrolled admin).
 */
const V1_EXEMPT_PURPOSES: ReadonlySet<CryptoPurpose> = new Set<CryptoPurpose>(['customer_ref']);

const s = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

const make = (table: string, column: string, row: unknown[], v1Exempt = false): CryptoContext =>
  v1Exempt ? { table, column, row: row.map(s), v1Exempt: true } : { table, column, row: row.map(s) };

export const ctx = {
  transfer: (id: string, column: TransferEncColumn): CryptoContext => make('transfers', column, [id]),
  customer: (partnerId: PartnerId, phone: string, column: CustomerEncColumn): CryptoContext =>
    make('customers', column, [partnerId, phone]),
  seller: (partnerId: PartnerId, phone: string): CryptoContext =>
    make('sellers', 'payout_destination_enc', [partnerId, phone]),
  recipient: (partnerId: PartnerId, senderPhone: string, recipientPhone: string): CryptoContext =>
    make('recipients', 'payout_destination_enc', [partnerId, senderPhone, recipientPhone]),
  beneficiary: (id: string): CryptoContext => make('beneficiaries', 'payout_destination_enc', [id]),
  schedule: (id: string): CryptoContext => make('schedules', 'payout_destination_enc', [id]),
  integration: (partnerId: PartnerId, column: IntegrationEncColumn): CryptoContext =>
    make('partner_integrations', column, [partnerId]),
  waitlist: (id: string, column: WaitlistEncColumn): CryptoContext => make('waitlist_signups', column, [id]),
  /** For fix 17b (staff MFA secrets in Redis). Permanently v1-exempt. */
  staffMfa: (username: string): CryptoContext => make('staff_mfa', 'secret', [username], true),
  purpose: (purpose: CryptoPurpose): CryptoContext =>
    make('purpose', purpose, [], V1_EXEMPT_PURPOSES.has(purpose)),
} as const;

// ── Row-shaped helpers: one per multi-part key, called with the fetched row on
// reads and with the values object on writes. ──

export const customerRowCtx = (
  row: { partnerId: PartnerId; phone: string },
  column: CustomerEncColumn,
): CryptoContext => ctx.customer(row?.partnerId, row?.phone, column);

/**
 * customers.email_enc is sealed OUTSIDE the repo (customer-auth-store, the
 * settings action) and stored verbatim by customerToRow. This applies the same
 * `partnerId ?? DEFAULT_PARTNER_ID` defaulting customerToRow uses for the row
 * key, so the blob is sealed for the row it will actually land in.
 */
export const customerEmailCtx = (c: { partnerId?: PartnerId; senderPhone: string }): CryptoContext =>
  ctx.customer(c?.partnerId ?? DEFAULT_PARTNER_ID, c?.senderPhone, 'email_enc');

export const recipientRowCtx = (row: {
  partnerId: PartnerId;
  senderPhone: string;
  recipientPhone: string;
}): CryptoContext => ctx.recipient(row?.partnerId, row?.senderPhone, row?.recipientPhone);

export const sellerRowCtx = (row: { partnerId: PartnerId; phone: string }): CryptoContext =>
  ctx.seller(row?.partnerId, row?.phone);

/**
 * The ONE mapping from an outbox `sealed` placeholder key to its purpose
 * context — used by the sealer (partners-action) and the opener (sealed-text).
 */
export const outboxSealedCtx = (key: string): CryptoContext =>
  key === 'apply_link' ? ctx.purpose('outbox.apply_link') : make('purpose', `outbox.${s(key)}`, []);
