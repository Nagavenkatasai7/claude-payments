import { quote, QuoteError, sourceForInr, wouldBeFeeUsd } from './fx';
import { getFxRates, type FxRates } from './rate';
import { resolveSendCurrency } from './partner-currency';
import { newTransferId } from './id';
import { env } from './env';
import { normalizePhone, isValidPhone } from './phone';
import { createTransfer } from './transfer-create';
import { evaluateCap, evaluateEdd } from './tier-rules';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { ScheduleStore } from './schedule-store';
import type { ChatTool, Customer, CurrencyCode, FundingMethod, Occupation, Partner, PayoutMethod, Schedule, SourceOfFunds, TurnContext } from './types';
import type { Store } from './store';
import type { DraftStore } from './draft-store';
import type { CustomerStore } from './customer-store';
import type { DailyVolumeStore } from './daily-volume-store';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { KycProvider } from './providers/kyc-provider';
import type { PartnerStore } from './partner-store';
import { sendInteractive, type InteractiveButton } from './whatsapp';
import {
  recipientButtonId,
  someoneNewButtonId,
  approveButtonId,
  cancelButtonId,
  disambiguateNames,
  truncateLabel,
} from './whatsapp-buttons';

// ── Approve message helpers ──────────────────────────────────────────────────

function maskDestination(method: PayoutMethod, dest: string): string {
  if (method === 'upi') return `UPI ${dest}`;
  // bank: "<acct> <ifsc>" or "<acct>, <ifsc>" → mask all but last 4 of the account
  const [acct, ...rest] = dest.split(/[,\s]+/).filter(Boolean);
  const last4 = (acct ?? '').slice(-4);
  const ifsc = rest.join(' ');
  return `bank a/c ****${last4}${ifsc ? `, IFSC ${ifsc}` : ''}`;
}

/**
 * Builds the enriched single-message body for the approve/cancel interactive.
 * Pure function; no I/O. Exported for unit-testing.
 */
export function buildApproveSummary(
  q: import('./types').Quote,
  recipientName: string,
  payoutMethod: PayoutMethod,
  payoutDestination: string,
  fundingMethod: FundingMethod,
): string {
  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: q.sourceCurrency }).format(n);
  const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

  let feeLine: string;
  if (q.feeUsd === 0) {
    // A2: first-transfer-free framing — show what the user saves vs a repeat send
    const ratio = q.amountUsd > 0 ? q.amountSource / q.amountUsd : 1; // USD→source scalar
    const wouldBeSource = Math.round(wouldBeFeeUsd(q.amountUsd, fundingMethod) * ratio * 100) / 100;
    feeLine = `first transfer free — you save ${fmt(wouldBeSource)}`;
  } else {
    feeLine = `Fee ${fmt(q.feeSource)}`;
  }

  return [
    `Sending ${fmt(q.amountSource)} to ${recipientName}.`,
    feeLine,
    `Rate: 1 ${q.sourceCurrency} = ${inr(q.fxRate)}`,
    `They get ${inr(q.amountInr)} ${q.deliveryEstimate}.`,
    `To: ${maskDestination(payoutMethod, payoutDestination)}`,
    `Rate locked ~10 min.`,
  ].join('\n');
}

// ── KYC closed-set validators: an unknown value is treated as UNSUPPLIED
// (fail-safe to flag, never silent-pass). Mirrors the type unions in types.ts. ──
const SOURCE_OF_FUNDS = ['employment','business','investment','gift','savings','other'] as const;
const OCCUPATIONS = ['salaried','self_employed','business_owner','student','homemaker','retired','unemployed','other'] as const;
const RELATIONSHIPS = ['self','spouse','parent','child','sibling','other_family','friend','business','other'] as const;
const PURPOSES = ['family_support','gift','education','medical','savings','bills','business','other'] as const;
function asEnum<T extends readonly string[]>(set: T, v: unknown): T[number] | undefined {
  return typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T[number]) : undefined;
}

export const toolSchemas: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_quote',
      description:
        'Calculate the fee, exchange rate, and rupee amount the recipient receives. Call this before confirming any transfer.',
      parameters: {
        type: 'object',
        properties: {
          amount_usd: {
            type: 'number',
            description: "Amount to send, in the sender's send currency (US dollars unless told otherwise).",
          },
          amount_inr: {
            type: 'number',
            description:
              "Optional. The exact rupee amount the RECIPIENT should receive. Provide this INSTEAD of amount_usd when the customer asks in rupees ('I want mom to get ₹40000'). We back-solve the send amount and add the fee on top. If both are given, amount_inr wins.",
          },
          funding_method: {
            type: 'string',
            enum: ['credit_card', 'debit_card', 'bank_transfer'],
            description:
              "How the sender pays: 'credit_card', 'debit_card', or 'bank_transfer'. The fee depends on this choice.",
          },
          source_currency: {
            type: 'string',
            description:
              "The currency the sender is sending in, e.g. 'USD' or 'GBP'. Only provide when you have been told more than one is available; otherwise omit it.",
          },
        },
        required: ['amount_usd', 'funding_method'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_transfer',
      description:
        'Create the transfer record after the user confirms the quote and provides recipient details.',
      parameters: {
        type: 'object',
        properties: {
          amount_usd: { type: 'number', description: "Amount to send, in the sender's send currency (US dollars unless told otherwise)." },
          recipient_name: { type: 'string' },
          payout_method: { type: 'string', enum: ['upi', 'bank'] },
          payout_destination: {
            type: 'string',
            description:
              'The UPI ID, or the bank account number with IFSC code.',
          },
          funding_method: {
            type: 'string',
            enum: ['credit_card', 'debit_card', 'bank_transfer'],
            description: "How the sender pays: 'credit_card', 'debit_card', or 'bank_transfer'.",
          },
          recipient_phone: {
            type: 'string',
            description:
              "The recipient's WhatsApp number in India, with country code, e.g. 919876543210.",
          },
          recipient_legal_name: { type: 'string', description: 'Recipient legal name (only when enhanced verification is required).' },
          relationship: { type: 'string', enum: ['self','spouse','parent','child','sibling','other_family','friend','business','other'] },
          purpose: { type: 'string', enum: ['family_support','gift','education','medical','savings','bills','business','other'] },
          source_of_funds: { type: 'string', enum: ['employment','business','investment','gift','savings','other'] },
          occupation: { type: 'string', enum: ['salaried','self_employed','business_owner','student','homemaker','retired','unemployed','other'] },
        },
        required: [
          'amount_usd',
          'recipient_name',
          'payout_method',
          'payout_destination',
          'funding_method',
          'recipient_phone',
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_payment_link',
      description:
        'Generate the secure link where the user enters payment details to pay.',
      parameters: {
        type: 'object',
        properties: { transfer_id: { type: 'string' } },
        required: ['transfer_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_payment_status',
      description: 'Check the current status of a transfer.',
      parameters: {
        type: 'object',
        properties: { transfer_id: { type: 'string' } },
        required: ['transfer_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_recipient_phone',
      description:
        "Add or correct the recipient's WhatsApp number on an existing transfer. Use this if a transfer was created without a valid recipient number.",
      parameters: {
        type: 'object',
        properties: {
          transfer_id: { type: 'string' },
          recipient_phone: {
            type: 'string',
            description:
              "Recipient's WhatsApp number with country code, e.g. 919876543210.",
          },
        },
        required: ['transfer_id', 'recipient_phone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_schedule',
      description:
        'Set up a recurring transfer that repeats monthly or weekly. Collect all recipient details first, just like create_transfer.',
      parameters: {
        type: 'object',
        properties: {
          amount_usd: { type: 'number', description: "Amount to send, in the sender's send currency (US dollars unless told otherwise)." },
          recipient_name: { type: 'string' },
          recipient_phone: { type: 'string', description: "Recipient's WhatsApp number with country code." },
          payout_method: { type: 'string', enum: ['upi', 'bank'] },
          payout_destination: { type: 'string' },
          funding_method: { type: 'string', enum: ['credit_card', 'debit_card', 'bank_transfer'] },
          frequency: { type: 'string', enum: ['monthly', 'weekly'] },
          day_of_month: { type: 'number', description: 'Day 1-28, required when frequency is monthly.' },
          day_of_week: { type: 'number', description: 'Day 0 (Sunday) to 6 (Saturday), required when frequency is weekly.' },
          source_currency: {
            type: 'string',
            description:
              "The currency the sender is sending in, e.g. 'USD' or 'GBP'. Only provide when you have been told more than one is available; otherwise omit it.",
          },
          recipient_legal_name: { type: 'string', description: 'Recipient legal name (only when enhanced verification is required).' },
          relationship: { type: 'string', enum: ['self','spouse','parent','child','sibling','other_family','friend','business','other'] },
          purpose: { type: 'string', enum: ['family_support','gift','education','medical','savings','bills','business','other'] },
          source_of_funds: { type: 'string', enum: ['employment','business','investment','gift','savings','other'] },
          occupation: { type: 'string', enum: ['salaried','self_employed','business_owner','student','homemaker','retired','unemployed','other'] },
        },
        required: ['amount_usd', 'recipient_name', 'recipient_phone', 'payout_method', 'payout_destination', 'funding_method', 'frequency'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_schedules',
      description: "List the customer's active recurring transfer schedules.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_schedule',
      description: 'Cancel a recurring transfer schedule by its id.',
      parameters: {
        type: 'object',
        properties: { schedule_id: { type: 'string' } },
        required: ['schedule_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_saved_recipients',
      description:
        "List the sender's recently-used recipients (top 2 by most recent). Call this on the first message of a new conversation.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_recipient_picker',
      description:
        'Send the sender a WhatsApp interactive message with reply buttons for each recipient plus a "Someone new" button. Provide 1 or 2 recipient entries.',
      parameters: {
        type: 'object',
        properties: {
          recipients: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                recipient_phone: { type: 'string' },
              },
              required: ['name', 'recipient_phone'],
            },
            description: 'Up to 2 recipient entries. Anything beyond 2 is dropped.',
          },
        },
        required: ['recipients'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_approve_picker',
      description:
        'Lock the quote and send the sender [Approve & pay] [Cancel] buttons. Call this when you have ALL transfer details: amount, funding method, recipient name, recipient phone, payout method, payout destination.',
      parameters: {
        type: 'object',
        properties: {
          amount_usd: { type: 'number', description: "Amount to send, in the sender's send currency (US dollars unless told otherwise)." },
          funding_method: { type: 'string', enum: ['credit_card', 'debit_card', 'bank_transfer'] },
          recipient_name: { type: 'string' },
          recipient_phone: { type: 'string' },
          payout_method: { type: 'string', enum: ['upi', 'bank'] },
          payout_destination: { type: 'string' },
          source_currency: {
            type: 'string',
            description:
              "The currency the sender is sending in, e.g. 'USD' or 'GBP'. Only provide when you have been told more than one is available; otherwise omit it.",
          },
          recipient_legal_name: { type: 'string', description: 'Recipient legal name (only when enhanced verification is required).' },
          relationship: { type: 'string', enum: ['self','spouse','parent','child','sibling','other_family','friend','business','other'] },
          purpose: { type: 'string', enum: ['family_support','gift','education','medical','savings','bills','business','other'] },
          source_of_funds: { type: 'string', enum: ['employment','business','investment','gift','savings','other'] },
          occupation: { type: 'string', enum: ['salaried','self_employed','business_owner','student','homemaker','retired','unemployed','other'] },
        },
        required: [
          'amount_usd',
          'funding_method',
          'recipient_name',
          'recipient_phone',
          'payout_method',
          'payout_destination',
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_draft',
      description:
        'Cancel the pending approval draft. Call this when the user taps [Cancel] or otherwise asks to cancel before paying. No arguments needed; the system supplies the draft id from the button-tap context.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_send_limit',
      description:
        "Check whether the sender is allowed to send `amount_usd` right now. Pass 0 to fetch their current cap status without proposing an amount. Returns { within_cap, tier, daily_cap_usd, per_transfer_cap_usd, today_used_usd, today_remaining_usd, reason?, day_of_window?, kyc_url?, edd_required, edd_threshold_usd }. Always call this BEFORE get_quote.",
      parameters: {
        type: 'object',
        properties: {
          amount_usd: {
            type: 'number',
            description: 'Amount the sender wants to send, in their send currency (USD unless told otherwise). Pass 0 for status-only.',
          },
          source_currency: {
            type: 'string',
            description:
              "The currency the sender is sending in, e.g. 'USD' or 'GBP'. Only provide when you have been told more than one is available; otherwise omit it.",
          },
        },
        required: ['amount_usd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'validate_phone',
      description:
        "Check that a recipient WhatsApp number is well-formed (digits only, with country code, 10–15 digits). Call this immediately after the user gives the recipient's number, BEFORE asking about payout. Returns { valid, normalized, error? }.",
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description: "The recipient's WhatsApp number as the user typed it, e.g. '+91 98765 43210'.",
          },
        },
        required: ['phone'],
      },
    },
  },
];

export interface ToolContext {
  phone: string;
  store: Store;
  scheduleStore: ScheduleStore;
  draftStore: DraftStore;
  turn: TurnContext;
  customerStore: CustomerStore;
  dailyVolumeStore: DailyVolumeStore;
  monthlyVolumeStore: MonthlyVolumeStore;   // NEW (KYC) — cumulative-month USD-equiv cents
  kycProvider: KycProvider;
  partnerStore: PartnerStore; // NEW (P4)
}

type ToolResult = Record<string, unknown>;

// Resolves the customer (upsert on first contact), their partner, the send
// currency for that partner, and fresh FX rates — all in one place so callers
// can reuse the customer and avoid duplicate Redis fetches.
async function resolveCurrencyAndRates(
  ctx: ToolContext,
  requested: unknown,
): Promise<{ customer: Customer; partner: Partner; sourceCurrency: CurrencyCode; rates: FxRates }> {
  const customer =
    (await ctx.customerStore.getCustomer(ctx.phone)) ??
    (await ctx.customerStore.upsertOnFirstInbound(ctx.phone)).customer;
  const partner =
    (await ctx.partnerStore.getPartner(customer.partnerId)) ??
    (await ctx.partnerStore.ensureDefaultPartner());
  const sourceCurrency = resolveSendCurrency(
    partner,
    typeof requested === 'string' ? requested : undefined,
  );
  const rates = await getFxRates(sourceCurrency);
  return { customer, partner, sourceCurrency, rates };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case 'get_quote':
      return getQuoteTool(args, ctx);
    case 'create_transfer':
      return createTransferTool(args, ctx);
    case 'generate_payment_link':
      return generatePaymentLinkTool(args, ctx);
    case 'check_payment_status':
      return checkPaymentStatusTool(args, ctx);
    case 'update_recipient_phone':
      return updateRecipientPhoneTool(args, ctx);
    case 'create_schedule':
      return createScheduleTool(args, ctx);
    case 'list_schedules':
      return listSchedulesTool(args, ctx);
    case 'cancel_schedule':
      return cancelScheduleTool(args, ctx);
    case 'list_saved_recipients':
      return listSavedRecipientsTool(args, ctx);
    case 'send_recipient_picker':
      return sendRecipientPickerTool(args, ctx);
    case 'send_approve_picker':
      return sendApprovePickerTool(args, ctx);
    case 'cancel_draft':
      return cancelDraftTool(args, ctx);
    case 'check_send_limit':
      return checkSendLimitTool(args, ctx);
    case 'validate_phone':
      return validatePhoneTool(args); // pure — no ctx
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function getQuoteTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const transferCount = await ctx.store.getTransferCount(ctx.phone);
    const { sourceCurrency, rates } = await resolveCurrencyAndRates(ctx, args.source_currency);

    // Receive-first (Win A): when a finite, positive target rupee amount is
    // given, back-solve the send amount; the recipient gets exactly that INR
    // and the fee is added on top (today's model). amount_inr wins over
    // amount_usd. Otherwise this is byte-for-byte today's send-first path.
    const targetInr = Number(args.amount_inr);
    const amountSource =
      Number.isFinite(targetInr) && targetInr > 0
        ? sourceForInr(targetInr, rates)
        : Number(args.amount_usd);

    const q = quote(
      amountSource,
      sourceCurrency,
      rates,
      args.funding_method as FundingMethod,
      transferCount,
    );
    return {
      source_currency: q.sourceCurrency,
      amount_source: q.amountSource,
      fee_source: q.feeSource,
      total_charge_source: q.totalChargeSource,
      amount_usd: q.amountUsd,
      fee_usd: q.feeUsd,
      total_charge_usd: q.totalChargeUsd,
      fx_rate: q.fxRate,
      amount_inr: q.amountInr,
      delivery_estimate: q.deliveryEstimate,
    };
  } catch (err) {
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
}

async function createTransferTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Approve-tap path: the system supplies the draftId via context.
  // The LLM cannot fabricate this; if no buttonTap.draftId is present, we
  // fall back to the legacy explicit-args path (cron uses it).
  const ctxDraftId =
    ctx.turn.buttonTap?.kind === 'approve' ? ctx.turn.buttonTap.draftId : null;

  if (ctxDraftId) {
    const draft = await ctx.draftStore.consumeDraft(ctxDraftId);
    if (!draft) {
      return {
        error:
          'That quote was already approved or has expired. Please request a fresh quote.',
      };
    }
    // Re-check cap at the moment of approval (cap state may have changed since picker).
    // Fetch customer ONCE — reuse for both the cap check and partnerId.
    const customer =
      (await ctx.customerStore.getCustomer(ctx.phone)) ??
      (await ctx.customerStore.upsertOnFirstInbound(ctx.phone)).customer;
    {
      const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
      const requestedCents = Math.round(draft.amountUsd * 100);
      const ev = evaluateCap(customer, new Date(), todayUsedCents, requestedCents);
      if (!ev.withinCap) {
        return {
          error: 'That quote would exceed your current sending cap. Please request a fresh quote.',
          cap_eval: { tier: ev.tier, reason: ev.reason, today_remaining_usd: ev.todayRemainingCents / 100 },
        };
      }
    }
    try {
      const transfer = await createTransfer(ctx.store, ctx.partnerStore, ctx.monthlyVolumeStore, {
        phone: ctx.phone,
        amountSource: draft.amountSource,
        sourceCurrency: draft.sourceCurrency,
        partnerId: customer.partnerId ?? DEFAULT_PARTNER_ID,
        recipientName: draft.recipient.name,
        recipientPhone: draft.recipient.recipientPhone,
        payoutMethod: draft.recipient.payoutMethod,
        payoutDestination: draft.recipient.payoutDestination,
        fundingMethod: draft.fundingMethod,
        // ── KYC Travel-Rule / EDD: from the consumed draft + sender legal name ──
        recipientLegalName: draft.recipientLegalName,
        relationship: draft.relationship,
        purpose: draft.purpose,
        sourceOfFunds: draft.sourceOfFunds,
        occupation: draft.occupation,
        senderName: customer.fullName,
      });
      await ctx.dailyVolumeStore.addCents(ctx.phone, Math.round(transfer.amountUsd * 100));
      await persistEddProfile(ctx, customer, draft.sourceOfFunds, draft.occupation);
      return {
        transfer_id: transfer.id,
        status: transfer.status,
        compliance_status: transfer.complianceStatus,
        compliance_reasons: transfer.complianceReasons,
        amount_inr: transfer.amountInr,
        total_charge_usd: transfer.totalChargeUsd,
        recipient_name: transfer.recipientName,
      };
    } catch (err) {
      if (err instanceof QuoteError) return { error: err.message };
      throw err;
    }
  }

  // Legacy explicit-args path (cold-start without buttons, or cron).
  const recipientPhone = normalizePhone(args.recipient_phone);
  if (!isValidPhone(recipientPhone)) {
    return {
      error:
        'A valid recipient WhatsApp number with country code is required before creating the transfer. Ask the user for it (e.g. 919876543210).',
    };
  }
  // Resolve currency + rates and reuse customer for cap check + partnerId.
  const { customer: legacyCustomer, sourceCurrency, rates } = await resolveCurrencyAndRates(
    ctx,
    args.source_currency,
  );
  const amountSource = Number(args.amount_usd);
  const amountUsd = Math.round(amountSource * rates.toUsd * 100) / 100;
  // Cap check on the legacy path (cron-fired or no-button cold-start)
  {
    const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
    const requestedCents = Math.round(amountUsd * 100);
    const ev = evaluateCap(legacyCustomer, new Date(), todayUsedCents, requestedCents);
    if (!ev.withinCap) {
      return {
        error: 'Cap exceeded for this transfer.',
        cap_eval: { tier: ev.tier, reason: ev.reason, today_remaining_usd: ev.todayRemainingCents / 100 },
      };
    }
  }
  const legacySof = asEnum(SOURCE_OF_FUNDS, args.source_of_funds);
  const legacyOcc = asEnum(OCCUPATIONS, args.occupation);
  try {
    const transfer = await createTransfer(ctx.store, ctx.partnerStore, ctx.monthlyVolumeStore, {
      phone: ctx.phone,
      amountSource,
      sourceCurrency,
      partnerId: legacyCustomer.partnerId ?? DEFAULT_PARTNER_ID,
      recipientName: String(args.recipient_name),
      recipientPhone,
      payoutMethod: args.payout_method as PayoutMethod,
      payoutDestination: String(args.payout_destination),
      fundingMethod: args.funding_method as FundingMethod,
      // ── KYC Travel-Rule / EDD: validated from args + sender legal name ──
      recipientLegalName: typeof args.recipient_legal_name === 'string' ? args.recipient_legal_name : undefined,
      relationship: asEnum(RELATIONSHIPS, args.relationship),
      purpose: asEnum(PURPOSES, args.purpose),
      sourceOfFunds: legacySof,
      occupation: legacyOcc,
      senderName: legacyCustomer.fullName,
    });
    await ctx.dailyVolumeStore.addCents(ctx.phone, Math.round(transfer.amountUsd * 100));
    await persistEddProfile(ctx, legacyCustomer, legacySof, legacyOcc);
    return {
      transfer_id: transfer.id,
      status: transfer.status,
      compliance_status: transfer.complianceStatus,
      compliance_reasons: transfer.complianceReasons,
      amount_inr: transfer.amountInr,
      total_charge_usd: transfer.totalChargeUsd,
      recipient_name: transfer.recipientName,
    };
  } catch (err) {
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
}

// Sticky EDD profile: when both SoF + occupation are supplied (validated) and
// differ from what's stored, persist them onto the Customer so future sends
// satisfy the EDD requirement without re-asking.
async function persistEddProfile(
  ctx: ToolContext,
  customer: Customer,
  sof: SourceOfFunds | undefined,
  occ: Occupation | undefined,
): Promise<void> {
  if (sof && occ && (customer.sourceOfFunds !== sof || customer.occupation !== occ)) {
    await ctx.customerStore.saveCustomer({
      ...customer, sourceOfFunds: sof, occupation: occ, eddCapturedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}

async function generatePaymentLinkTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const transfer = await ctx.store.getTransfer(String(args.transfer_id));
  if (!transfer) return { error: 'Transfer not found.' };
  if (transfer.status === 'blocked') {
    return {
      error: 'This transfer did not pass compliance and cannot be paid.',
    };
  }
  return { url: `${env.appBaseUrl}/pay/${transfer.id}` };
}

async function checkPaymentStatusTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const transfer = await ctx.store.getTransfer(String(args.transfer_id));
  if (!transfer) return { error: 'Transfer not found.' };
  return { transfer_id: transfer.id, status: transfer.status };
}

async function updateRecipientPhoneTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const transfer = await ctx.store.getTransfer(String(args.transfer_id));
  if (!transfer) return { error: 'Transfer not found.' };

  const recipientPhone = normalizePhone(args.recipient_phone);
  if (!isValidPhone(recipientPhone)) {
    return {
      error:
        'That does not look like a valid WhatsApp number. Please provide it with country code, e.g. 919876543210.',
    };
  }

  transfer.recipientPhone = recipientPhone;
  await ctx.store.saveTransfer(transfer);
  return {
    transfer_id: transfer.id,
    recipient_phone: recipientPhone,
    recipient_name: transfer.recipientName,
    status: transfer.status,
  };
}

async function createScheduleTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const recipientPhone = normalizePhone(args.recipient_phone);
  if (!isValidPhone(recipientPhone)) {
    return { error: 'A valid recipient WhatsApp number with country code is required.' };
  }
  const frequency = args.frequency === 'weekly' ? 'weekly' : 'monthly';
  let dayOfMonth: number | undefined;
  let dayOfWeek: number | undefined;
  if (frequency === 'monthly') {
    dayOfMonth = Number(args.day_of_month);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
      return { error: 'For a monthly schedule, pick a day of the month between 1 and 28.' };
    }
  } else {
    dayOfWeek = Number(args.day_of_week);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      return { error: 'For a weekly schedule, pick a day of the week from 0 (Sunday) to 6 (Saturday).' };
    }
  }
  // Resolve currency and reuse customer for partnerId (P4 wiring).
  const { customer: owner, sourceCurrency } = await resolveCurrencyAndRates(ctx, args.source_currency);
  const partnerId = owner.partnerId ?? DEFAULT_PARTNER_ID;
  const amountSource = Number(args.amount_usd);
  const schedule: Schedule = {
    id: newTransferId(),
    phone: ctx.phone,
    amountUsd: amountSource, // kept as source amount (USD-equivalent when USD; else raw source)
    recipientName: String(args.recipient_name),
    recipientPhone,
    payoutMethod: args.payout_method as Schedule['payoutMethod'],
    payoutDestination: String(args.payout_destination),
    fundingMethod: args.funding_method as Schedule['fundingMethod'],
    frequency,
    dayOfMonth,
    dayOfWeek,
    status: 'active',
    createdAt: new Date().toISOString(),
    partnerId,
    sourceCurrency,
    amountSource,
  };
  await ctx.scheduleStore.saveSchedule(schedule);
  return {
    schedule_id: schedule.id,
    frequency: schedule.frequency,
    day_of_month: schedule.dayOfMonth ?? null,
    day_of_week: schedule.dayOfWeek ?? null,
  };
}

async function listSchedulesTool(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const all = await ctx.scheduleStore.listActiveSchedules();
  const mine = all.filter((s) => s.phone === ctx.phone);
  return {
    schedules: mine.map((s) => ({
      schedule_id: s.id,
      amount_usd: s.amountUsd,
      recipient_name: s.recipientName,
      frequency: s.frequency,
      day_of_month: s.dayOfMonth ?? null,
      day_of_week: s.dayOfWeek ?? null,
    })),
  };
}

async function cancelScheduleTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const schedule = await ctx.scheduleStore.getSchedule(String(args.schedule_id));
  if (!schedule || schedule.phone !== ctx.phone) {
    return { error: 'Schedule not found.' };
  }
  schedule.status = 'cancelled';
  await ctx.scheduleStore.saveSchedule(schedule);
  return { schedule_id: schedule.id, status: schedule.status };
}

async function listSavedRecipientsTool(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const recipients = await ctx.store.listRecipients(ctx.phone, 2);
    return {
      recipients: recipients.map((r) => ({
        name: r.name,
        recipient_phone: r.recipientPhone,
        payout_method: r.payoutMethod,
        payout_destination: r.payoutDestination,
        last_used_at: r.lastUsedAt,
      })),
    };
  } catch (err) {
    console.warn('listRecipients failed; returning []:', err);
    return { recipients: [] };
  }
}

async function sendRecipientPickerTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const rawList = Array.isArray(args.recipients)
    ? (args.recipients as { name?: unknown; recipient_phone?: unknown }[])
    : [];
  if (rawList.length === 0) {
    return { error: 'send_recipient_picker requires at least 1 recipient.' };
  }
  // Cap server-side at 2; ignore excess silently.
  const capped = rawList.slice(0, 2).map((r) => ({
    name: String(r.name ?? '').trim(),
    recipientPhone: normalizePhone(r.recipient_phone),
  }));
  const labels = disambiguateNames(capped);
  const buttons: InteractiveButton[] = capped.map((r, i) => ({
    id: recipientButtonId(r.recipientPhone),
    title: truncateLabel(labels[i]),
  }));
  buttons.push({
    id: someoneNewButtonId(),
    title: 'Someone new',
  });

  await sendInteractive(
    ctx.phone,
    'Welcome back 👋 Who are we sending to?',
    buttons,
  );
  return { sent: true };
}

async function sendApprovePickerTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const recipientPhone = normalizePhone(args.recipient_phone);
  if (!isValidPhone(recipientPhone)) {
    return {
      error:
        "A valid recipient WhatsApp number with country code is required (e.g. 919876543210).",
    };
  }
  const fundingMethod = args.funding_method as FundingMethod;
  // Resolve currency+rates ONCE; reuse `customer` for the cap check (no second getCustomer).
  const { customer, sourceCurrency, rates } = await resolveCurrencyAndRates(ctx, args.source_currency);
  const amountSource = Number(args.amount_usd);
  const amountUsd = Math.round(amountSource * rates.toUsd * 100) / 100;
  // Cap enforcement (defense in depth — check_send_limit + this + create_transfer)
  {
    const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
    const requestedCents = Math.round(amountUsd * 100);
    const ev = evaluateCap(customer, new Date(), todayUsedCents, requestedCents);
    if (!ev.withinCap) {
      return {
        error: 'Cap exceeded for this transfer.',
        cap_eval: {
          tier: ev.tier,
          reason: ev.reason,
          today_used_usd: ev.todayUsedCents / 100,
          today_remaining_usd: ev.todayRemainingCents / 100,
          daily_cap_usd: ev.dailyCapCents / 100,
        },
      };
    }
  }
  try {
    const transferCount = await ctx.store.getTransferCount(ctx.phone);
    const q = quote(amountSource, sourceCurrency, rates, fundingMethod, transferCount);
    const draftId = await ctx.draftStore.createDraft({
      senderPhone: ctx.phone,
      recipient: {
        name: String(args.recipient_name),
        recipientPhone,
        payoutMethod: args.payout_method as PayoutMethod,
        payoutDestination: String(args.payout_destination),
      },
      amountUsd: q.amountUsd,
      amountSource: q.amountSource,
      sourceCurrency: q.sourceCurrency,
      fundingMethod,
      // ── KYC Travel-Rule / EDD enums (validated; unknown ⇒ unsupplied) ──
      recipientLegalName: typeof args.recipient_legal_name === 'string' ? args.recipient_legal_name : undefined,
      relationship: asEnum(RELATIONSHIPS, args.relationship),
      purpose: asEnum(PURPOSES, args.purpose),
      sourceOfFunds: asEnum(SOURCE_OF_FUNDS, args.source_of_funds),
      occupation: asEnum(OCCUPATIONS, args.occupation),
      quote: { feeUsd: q.feeUsd, fxRate: q.fxRate, amountInr: q.amountInr },
    });
    const summary = buildApproveSummary(
      q,
      String(args.recipient_name),
      args.payout_method as PayoutMethod,
      String(args.payout_destination),
      fundingMethod,
    );
    await sendInteractive(ctx.phone, summary, [
      { id: approveButtonId(draftId), title: 'Approve & pay' },
      { id: cancelButtonId(draftId), title: 'Cancel' },
    ]);
    return { sent: true, draft_id: draftId };
  } catch (err) {
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
}

async function cancelDraftTool(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const draftId = ctx.turn.buttonTap?.kind === 'cancel'
    ? ctx.turn.buttonTap.draftId
    : null;
  if (!draftId) {
    return { error: 'No active draft to cancel.' };
  }
  const draft = await ctx.draftStore.consumeDraft(draftId);
  if (!draft) {
    return { cancelled: false, reason: 'draft_not_found_or_expired' };
  }
  return { cancelled: true };
}

function validatePhoneTool(args: Record<string, unknown>): ToolResult {
  const normalized = normalizePhone(args.phone ?? '');
  if (!isValidPhone(normalized)) {
    return {
      valid: false,
      normalized,
      error:
        "That doesn't look like a valid WhatsApp number — please send it with country code, e.g. 919876543210.",
    };
  }
  return { valid: true, normalized };
}

async function checkSendLimitTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Resolve currency+rates and reuse `customer` — no second getCustomer.
  const { customer, rates } = await resolveCurrencyAndRates(ctx, args.source_currency);
  const amountSource = Number(args.amount_usd ?? 0);
  // Convert to USD-equivalent for the cap evaluation (for USD partners toUsd===1).
  const amountUsd = Math.round(amountSource * rates.toUsd * 100) / 100;
  const requestedCents = Math.round(amountUsd * 100);
  const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
  const evalResult = evaluateCap(customer, new Date(), todayUsedCents, requestedCents);

  const monthUsedCents = await ctx.monthlyVolumeStore.getMonthCents(ctx.phone);   // NEW (KYC)
  const edd = evaluateEdd(monthUsedCents, requestedCents);                         // NEW (KYC)
  const eddFieldsPresent = Boolean(customer.sourceOfFunds && customer.occupation); // NEW (KYC)

  // Surface a KYC URL for T0 or Suspended (the agent uses this in the message).
  let kycUrl: string | undefined;
  if (evalResult.tier === 'T0' || evalResult.tier === 'Suspended') {
    const start = await ctx.kycProvider.startVerification({
      customerId: ctx.phone,
      senderPhone: ctx.phone,
    });
    kycUrl = start.url;
  }

  return {
    within_cap: evalResult.withinCap,
    tier: evalResult.tier,
    daily_cap_usd: evalResult.dailyCapCents / 100,
    per_transfer_cap_usd: evalResult.perTransferCapCents / 100,
    today_used_usd: evalResult.todayUsedCents / 100,
    today_remaining_usd: evalResult.todayRemainingCents / 100,
    reason: evalResult.reason,
    day_of_window: evalResult.dayOfWindow,
    kyc_url: kycUrl,
    edd_required: edd.eddRequired && !eddFieldsPresent,   // false on the dormant path
    edd_threshold_usd: edd.thresholdCents / 100,          // 3000 (for messaging)
  };
}
