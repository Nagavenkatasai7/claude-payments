import { createHash } from 'node:crypto';
import * as z from 'zod';
import type { AgentPrincipal } from '@/lib/agent-auth';
import { getDb } from '@/db/client';
import { draftPaymentStarted } from '@/lib/pay-finalize';
import { isMaskedDestination } from '@/lib/payout-format';
import { auditSubjectId } from '@/lib/customer-ref';
import { DEFAULT_BRAND } from '@/lib/partner-config';
import { destinationCountryForRecipientPhone } from '@/lib/partner-currency';
import { isSupportedDestination, SUPPORTED_DESTINATIONS } from '@/lib/destination-country';
import { DRAFT_TTL_SECONDS } from '@/lib/draft-store';
import { checkIpRateLimit } from '@/lib/ip-rate-limit';
import { logWarn } from '@/lib/log';
import { normalizePhone } from '@/lib/phone';
import { findByRid } from '@/lib/portal-recipients';
import { BadRequestKeyError, RequestInFlightError, runOnce } from '@/lib/portal-request-key';
import {
  isDraftId,
  limitsCopy,
  narrowSendLimits,
  portalKycGate,
  portalToolContext,
  prepareResultCopy,
  PORTAL_FUNDING_METHODS,
  type SendCopy,
} from '@/lib/portal-send';
import { TRANSFER_PURPOSES } from '@/lib/purpose-codes';
import { decidePurpose, type PurposeDetailCode } from '@/lib/purpose-detail';
import { payUrlFor, prepareSendDraft, type PrepareSendInput } from '@/lib/send-seam';
import { executeTool, maskAccount, rateLockMinutes } from '@/lib/tools';
import { boundUntrustedText, NAME_MAX } from '@/lib/untrusted-text';
import type { RedisLike } from '@/lib/store';
import type { CountryCode, Draft } from '@/lib/types';
import type { ToolOutcome } from './guard';
import { CANNOT_PAY, type McpDataDeps, type McpToolSpec } from './tools';

// Stage C2: the two tools that let an AI app PREPARE a transfer, never pay it. prepare_transfer
// makes ONE draft through the bot's own seam (send-seam.ts prepareSendDraft, the same path the
// customer portal's "Continue to pay" takes, with every obligation that file lists), on the web
// pointer, marked with the app that asked (Draft.preparedBy). The customer then opens the pay
// link and pays on the SmartRemit pay page with a code sent to their WhatsApp: the claim-first
// mint, the kill switches, the sanctions screen and the FX checks all stay there. Nothing here
// mints, settles or takes a payout destination: the recipient is one of the customer's OWN saved
// recipients, found by the portal's opaque id, and its payout is resolved on the server.
//
// cancel_prepared_transfer removes a draft that THIS app prepared for THIS customer and that is
// not paid yet. Everything else (unknown, another customer's, another app's, paid, expired)
// answers the same "not found".

const destinations = SUPPORTED_DESTINATIONS as [CountryCode, ...CountryCode[]];

/** A retry of the same prepare (same app connection, same details) inside this window returns the same draft. */
export const PREPARE_REPLAY_TTL_S = 120;

export const RECIPIENT_NOT_FOUND = 'Recipient not found. Use list_recipients to get a recipient_id.';
export const PREPARED_NOT_FOUND =
  'Prepared transfer not found. It may be paid, cancelled or expired. A paid transfer cannot be cancelled here; use get_transfer_status.';
export const PREPARE_TOO_MANY = 'Too many transfers were prepared in the last hour. Try again later.';
export const PREPARE_FAILED = 'This transfer could not be prepared right now. Please try again later.';
export const NO_SAVED_ACCOUNT =
  'This recipient has no saved account for that country. The customer can send to them in SmartRemit on WhatsApp or the SmartRemit portal.';
export const PREPARED_BEING_PAID =
  'This prepared transfer is being paid now, so it cannot be cancelled. Use get_transfer_status with prepared_transfer_id.';

/**
 * Per customer, all apps together. Its OWN budget (security review): an app that uses it up never
 * blocks the customer's own portal sends (PORTAL_SEND_LIMIT).
 */
export const MCP_PREPARE_LIMIT = { scope: 'mcp-prepare-hour', limit: 10, windowSec: 3600 } as const;

export const PAY_STEP =
  'Give the customer pay_url. They check the details and pay on the SmartRemit pay page, with a code sent to their WhatsApp. ' +
  'Nothing is paid until they do. After they pay, get_transfer_status with prepared_transfer_id shows the status.';

export interface PrepareDeps extends McpDataDeps {
  redis: RedisLike;
  now?: () => number;
}

// ── prepare_transfer ─────────────────────────────────────────────────────────

export const PREPARE_TRANSFER: McpToolSpec = {
  name: 'prepare_transfer',
  title: 'Prepare a transfer',
  scope: 'transfers:prepare',
  description:
    'Prepare a transfer to one of the customer\'s saved recipients (recipient_id from list_recipients) and get the pay link. ' +
    'It uses the same limits, purpose rules and checks as SmartRemit on WhatsApp. The rate is locked while the link is open (up to 30 minutes). ' +
    'Confirm the recipient, the amount and the purpose with the customer before you call it. ' +
    `${CANNOT_PAY}`,
};

export const prepareTransferInput = z.object({
  recipient_id: z.string().min(1).max(80).describe('The recipient_id of a saved recipient, from list_recipients.'),
  amount: z.number().positive().max(1_000_000).describe("The amount to SEND, in the sender's currency (not converted)."),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional()
    .describe("The sender's currency, ISO 4217 (for example USD). Absent: the customer's own currency."),
  destination_country: z
    .enum(destinations)
    .optional()
    .describe("Where the money goes, ISO 3166 alpha-2. Absent: the country of the recipient's phone number, else IN (India)."),
  funding_method: z.enum(PORTAL_FUNDING_METHODS).optional().describe('How the customer pays. Absent: bank_transfer.'),
  purpose: z.enum(TRANSFER_PURPOSES).describe('Why the customer sends the money. Ask the customer if it is not clear.'),
  purpose_detail: z
    .string()
    .max(480)
    .optional()
    .describe('Required when purpose is "other": the customer\'s own reason, 10 to 120 characters.'),
});

export type PrepareTransferArgs = z.infer<typeof prepareTransferInput>;

const PURPOSE_DETAIL_MESSAGE: Record<PurposeDetailCode, string> = {
  missing: 'Purpose "other" needs purpose_detail: the customer\'s own reason, 10 to 120 characters.',
  too_short: 'purpose_detail is too short. It needs 10 to 120 characters, in the customer\'s own words.',
  too_long: 'purpose_detail is too long. It needs 10 to 120 characters.',
  nonsense: 'purpose_detail is not clear. Ask the customer for their reason in their own words.',
};

const SCAM_REVIEW =
  'This reason needs the customer to read a safety warning before they send. The customer can send this transfer in the SmartRemit portal.';

/**
 * The portal's fixed refusal copy (portal-send.ts SendCopy), told to the AI in plain words. The
 * portal decides WHICH refusal applies; this only words it for an app, never with a raw seam message.
 */
export function refusalMessage(c: SendCopy): string {
  switch (c.error) {
    case 'portal.send.kycBody':
    case 'portal.send.cap_verify':
      return 'The customer must verify their identity first, in SmartRemit on WhatsApp or the SmartRemit portal.';
    case 'portal.send.contact_partner':
      return 'SmartRemit cannot accept transfers from this account. The customer should contact SmartRemit support.';
    case 'portal.send.cap_daily':
      return `This is more than the customer can send today. They can still send ${c.vars?.remaining ?? 'less'} today.`;
    case 'portal.send.cap_per_transfer':
      return `This is more than one transfer allows. The most is ${c.vars?.max ?? 'lower'}.`;
    case 'portal.send.edd_whatsapp':
      return 'SmartRemit needs a few more details before this transfer. The customer can give them in SmartRemit on WhatsApp.';
    case 'portal.send.name_needed':
      return "SmartRemit needs the customer's full legal name first. They can add it in SmartRemit on WhatsApp or on the portal's Send page.";
    case 'portal.send.fx_unavailable':
      return 'An exchange rate is not available right now. Try again in a few minutes.';
    case 'portal.send.amount_not_allowed':
      return 'SmartRemit cannot send this amount. Try a different amount.';
    case 'portal.send.destination_invalid':
    case 'portal.send.phone_invalid':
      return 'This recipient cannot receive in that country. Check destination_country with the customer.';
    default:
      return 'This transfer cannot be prepared. The customer can contact SmartRemit support.';
  }
}

/** The masked payout line of a saved recipient: its type and, for a bank account, the last 4 digits only. */
function maskedPayout(r: Draft['recipient']): { payout_type: string; account_last4: string | null } {
  const payout_type = r.payoutMethod === 'upi' || r.payoutMethod === 'usdc' ? r.payoutMethod : 'bank';
  if (r.payoutMethod === 'upi') return { payout_type, account_last4: null };
  const m = /^\*{4}(\d{1,4})$/.exec(maskAccount(r.payoutMethod, r.payoutDestination ?? ''));
  return { payout_type, account_last4: m ? m[1] : null };
}

/** The answer for a live draft: the amounts the pay page shows, never the payout destination. */
export function preparedView(draftId: string, d: Draft, now: number): Record<string, unknown> {
  const createdAt = Date.parse(d.createdAt);
  const expiresAt = new Date((Number.isFinite(createdAt) ? createdAt : now) + DRAFT_TTL_SECONDS * 1000).toISOString();
  const fee = d.quote.feeSource ?? d.quote.feeUsd;
  return {
    prepared: true,
    prepared_transfer_id: draftId,
    pay_url: payUrlFor(draftId),
    recipient_name: d.recipient.name,
    ...maskedPayout(d.recipient),
    send_amount: d.amountSource,
    send_currency: d.sourceCurrency,
    fee,
    total_to_pay: d.quote.totalChargeSource ?? d.quote.totalChargeUsd ?? d.amountSource + fee,
    exchange_rate: d.quote.fxRate,
    recipient_gets: d.quote.amountInr,
    recipient_currency: d.quote.destinationCurrency ?? d.destinationCurrency ?? 'INR',
    destination_country: d.destinationCountry ?? 'IN',
    purpose: d.purpose,
    rate_locked_minutes: rateLockMinutes(d.quote.fxFetchedAt, now, d.quote.routeExpiresAt),
    expires_at: expiresAt,
    next_step: PAY_STEP,
  };
}

/** The retry key: one app connection, one set of details. 32 hex characters (runOnce's key shape). */
export function prepareRequestKey(grantId: string, a: PrepareTransferArgs): string {
  const parts = [
    grantId,
    a.recipient_id,
    String(a.amount),
    a.currency?.toUpperCase() ?? '',
    a.destination_country ?? '',
    a.funding_method ?? '',
    a.purpose,
    a.purpose_detail ?? '',
  ];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/** MCP_PREPARE_LIMIT. Fails OPEN on a limiter error. */
async function withinSendLimit(redis: RedisLike, partnerId: string, phone: string, now: number): Promise<boolean> {
  try {
    const r = await checkIpRateLimit(redis, MCP_PREPARE_LIMIT.scope, auditSubjectId(partnerId, phone), {
      limit: MCP_PREPARE_LIMIT.limit,
      windowSec: MCP_PREPARE_LIMIT.windowSec,
      now,
    });
    return r.allowed;
  } catch {
    logWarn('mcp.prepare.limit', 'limiter unavailable');
    return true;
  }
}

/** A refusal inside the replay guard: thrown, so runOnce drops its claim and a corrected retry runs again. */
class Refused extends Error {
  constructor(readonly reason: string) {
    super('refused');
    this.name = 'Refused';
  }
}

export async function prepareTransferTool(principal: AgentPrincipal, args: PrepareTransferArgs, deps: PrepareDeps): Promise<ToolOutcome> {
  const now = deps.now?.() ?? Date.now();
  // The ONLY identity: the verified token's tenant and customer.
  const owner = { partnerId: principal.partnerId, phone: principal.phone };
  const ctx = portalToolContext(owner, deps.toolDeps);

  // Required purpose (owner decision 2026-10-08) and the A3 reason rule, before anything is read.
  const decided = decidePurpose(args.purpose, args.purpose_detail);
  if (!decided.ok) return { ok: false, message: PURPOSE_DETAIL_MESSAGE[decided.code] };
  // A4: the portal shows a scam warning the customer must tick; an app cannot, so it is refused here.
  if (decided.risk) return { ok: false, message: SCAM_REVIEW };

  let draftId: string;
  try {
    ({
      value: { draftId },
    } = await runOnce(
      deps.redis,
      'mcp-prepare',
      owner.partnerId,
      owner.phone,
      prepareRequestKey(principal.grantId, args),
      async (): Promise<{ draftId: string }> => {
        if (!(await withinSendLimit(deps.redis, owner.partnerId, owner.phone, now))) throw new Refused(PREPARE_TOO_MANY);

        // The customer's OWN live saved recipient (another tenant's rid and a deleted one are "not found").
        const recipient = await findByRid(deps.db ?? getDb(), owner.partnerId, owner.phone, args.recipient_id);
        if (!recipient) throw new Refused(RECIPIENT_NOT_FOUND);

        // The pure KYC gate first, so a gated customer never reaches a seam call (send-seam obligations).
        const [customer, partner] = await Promise.all([
          ctx.customerStore.getCustomer(owner.partnerId, owner.phone),
          ctx.partnerStore.getPartner(owner.partnerId),
        ]);
        const gated = portalKycGate(partner, customer, DEFAULT_BRAND);
        if (gated) throw new Refused(refusalMessage(gated));

        // The cap + EDD pre-check (check_send_limit), exactly as the portal's Continue runs it.
        const currency = args.currency?.toUpperCase();
        const limits = narrowSendLimits(
          await executeTool('check_send_limit', { amount_usd: args.amount, ...(currency ? { source_currency: currency } : {}) }, ctx),
        );
        const limitRefusal = limitsCopy(limits, DEFAULT_BRAND);
        if (limitRefusal) throw new Refused(refusalMessage(limitRefusal));

        const recipientPhone = normalizePhone(recipient.recipientPhone);
        const fromPhone = destinationCountryForRecipientPhone(recipientPhone);
        const destinationCountry = args.destination_country ?? (fromPhone && isSupportedDestination(fromPhone) ? fromPhone : undefined);
        const recipientName = boundUntrustedText(recipient.name, NAME_MAX);
        if (!recipientName) throw new Refused(RECIPIENT_NOT_FOUND);

        // The consumer subset only (send-seam obligations): no B2B field, no EDD enum but the purpose.
        const input: PrepareSendInput = {
          recipientPhone,
          recipientName,
          amountSource: args.amount,
          ...(currency ? { sourceCurrency: currency } : {}),
          ...(destinationCountry ? { destinationCountry } : {}),
          fundingMethod: args.funding_method ?? 'bank_transfer',
          purpose: decided.purpose,
          ...(decided.detail ? { purposeDetail: decided.detail } : {}),
        };
        const r = await prepareSendDraft(ctx, input, {
          pointer: 'web',
          preparedBy: { clientId: principal.clientId, appName: boundUntrustedText(principal.clientName, NAME_MAX) },
        });
        if (r.kind !== 'draft') throw new Refused(refusalMessage(prepareResultCopy(r, DEFAULT_BRAND)));
        // An app-prepared draft pays ONLY a stored account (the pay page never takes bank details
        // for it, pay-finalize.ts). With none on file, the draft could never be paid: remove it.
        const made = await ctx.draftStore.getDraft(r.draftId);
        const dest = (made?.recipient.payoutDestination ?? '').trim();
        if (!made || dest === '' || isMaskedDestination(dest)) {
          await ctx.draftStore.consumeDraft(r.draftId);
          throw new Refused(NO_SAVED_ACCOUNT);
        }
        return { draftId: r.draftId };
      },
      PREPARE_REPLAY_TTL_S,
    ));
  } catch (err) {
    if (err instanceof Refused) return { ok: false, message: err.reason };
    if (err instanceof RequestInFlightError) return { ok: false, message: 'The same transfer is being prepared. Wait a moment, then try again.' };
    if (!(err instanceof BadRequestKeyError)) logWarn('mcp.prepare', 'prepare failed', { err: err instanceof Error ? err.name : 'error' });
    return { ok: false, message: PREPARE_FAILED };
  }

  // First run and replay alike: read the draft back, so the answer is what the pay page shows.
  const draft = await ctx.draftStore.getDraft(draftId);
  if (!draft || !ownDraft(draft, principal)) {
    return {
      ok: false,
      message: 'This same transfer was prepared a moment ago and is no longer open (paid, cancelled or expired). Check list_recent_transfers.',
    };
  }
  return { ok: true, data: preparedView(draftId, draft, now), draftId };
}

// ── cancel_prepared_transfer ─────────────────────────────────────────────────

export const CANCEL_PREPARED_TRANSFER: McpToolSpec = {
  name: 'cancel_prepared_transfer',
  title: 'Cancel a prepared transfer',
  scope: 'transfers:prepare',
  description:
    'Cancel a transfer this app prepared (prepared_transfer_id from prepare_transfer) while it is not paid. Its pay link stops working. ' +
    `It cannot cancel or refund a paid transfer. ${CANNOT_PAY}`,
};

export const cancelPreparedTransferInput = z.object({
  prepared_transfer_id: z.string().min(1).max(80).describe('The prepared_transfer_id from prepare_transfer.'),
});

/** This customer's draft, in this tenant, prepared by this same app. */
function ownDraft(d: Draft, principal: AgentPrincipal): boolean {
  return (
    d.partnerId === principal.partnerId &&
    normalizePhone(d.senderPhone) === normalizePhone(principal.phone) &&
    d.preparedBy?.clientId === principal.clientId
  );
}

export async function cancelPreparedTransferTool(
  principal: AgentPrincipal,
  args: z.infer<typeof cancelPreparedTransferInput>,
  deps: McpDataDeps,
): Promise<ToolOutcome> {
  const id = args.prepared_transfer_id.trim();
  if (!isDraftId(id)) return { ok: false, message: PREPARED_NOT_FOUND };
  const store = portalToolContext({ partnerId: principal.partnerId, phone: principal.phone }, deps.toolDeps).draftStore;
  // Read first: a draft that is not ours is never consumed, not even for a moment.
  const seen = await store.getDraft(id);
  if (!seen || !ownDraft(seen, principal)) return { ok: false, message: PREPARED_NOT_FOUND };
  const taken = await store.consumeDraft(id);
  if (!taken) return { ok: false, message: PREPARED_NOT_FOUND }; // paid (minted) or expired in between
  if (!ownDraft(taken, principal)) {
    await store.restoreDraft(taken, id);
    return { ok: false, message: PREPARED_NOT_FOUND };
  }
  // A payment under way has claimed the draft (pay-finalize.ts, which re-reads the draft after
  // its claim). Consume first, then look: one side always sees the other. Give the draft back.
  if (await draftPaymentStarted(deps.db ?? getDb(), id)) {
    await store.restoreDraft(taken, id);
    return { ok: false, message: PREPARED_BEING_PAID };
  }
  return {
    ok: true,
    data: { cancelled: true, prepared_transfer_id: id, next_step: 'Tell the customer the transfer is cancelled. Nothing was paid.' },
    draftId: id,
  };
}
