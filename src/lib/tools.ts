import { quote, QuoteError, sourceForInr, wouldBeFeeUsd } from './fx';
import { getFxRates, type FxRates } from './rate';
import { resolveSendCurrency } from './partner-currency';
import { newTransferId } from './id';
import { env } from './env';
import { normalizePhone, isValidPhone } from './phone';
import { createTransfer, recordBlockedAttempt } from './transfer-create';
import { isSendVerified, SEND_GATE_REASON, sendGateActive } from './kyc-gate';
import { evaluateCap, evaluateEdd } from './tier-rules';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { ScheduleStore } from './schedule-store';
import type { ChatTool, CountryCode, Customer, CurrencyCode, FundingMethod, Occupation, Partner, PayoutMethod, Schedule, SourceOfFunds, TurnContext } from './types';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from './types';
import type { Store } from './store';
import type { DraftStore } from './draft-store';
import type { CustomerStore } from './customer-store';
import type { DailyVolumeStore } from './daily-volume-store';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { KycProvider } from './providers/kyc-provider';
import type { PartnerStore } from './partner-store';
import { sendInteractive, sendCtaUrl, type InteractiveButton, type WaCreds } from './whatsapp';
import {
  recipientButtonId,
  someoneNewButtonId,
  disambiguateNames,
  truncateLabel,
} from './whatsapp-buttons';
import { screenTransfer } from './compliance';

// ── Approve message helpers ──────────────────────────────────────────────────

/**
 * Returns the last 4 digits of the account number in a payout string, or '' if
 * it contains no digits. `composePayoutDestination` (in payout-format.ts) always
 * places the account field LAST, so the account is the LAST run of digits — we
 * take that run's tail, consistent with `accountLast4` there. We never keep any
 * other part of the string, so nothing but these ≤4 digits can ever surface —
 * leak-proof in every supported format.
 */
function accountLast4(dest: string): string {
  const runs = dest.match(/\d+/g);
  if (!runs || runs.length === 0) return '';
  const last = runs[runs.length - 1];
  return last.slice(-4);
}

/**
 * Masks a payout_destination for tool responses fed back to the LLM
 * (list_saved_recipients / resolve_recipient): UPI IDs pass through unchanged
 * (no account digits to hide); bank destinations collapse to "****<last4>" so a
 * full account number — or an IBAN, which embeds the account — can never be
 * echoed by the model.
 */
export function maskAccount(payoutMethod: PayoutMethod, payoutDestination: string): string {
  if (payoutMethod === 'upi') return payoutDestination;
  const last4 = accountLast4(payoutDestination);
  return last4 ? `****${last4}` : 'account on file';
}

// Cold-start placeholder for the approve card's "To:" line when no bank details
// have been collected yet (Item 2: the sender enters them on the secure pay
// page, never in chat). A saved/known destination still renders the masked
// "bank a/c ****<last4>" line.
export const NO_BANK_DETAILS_PLACEHOLDER =
  "their bank account (you'll enter the details on the secure page)";

/**
 * Masks a payout_destination for the customer-facing approval card. Shows ONLY
 * the account's last 4 digits — no routing/sort/IFSC code and no IBAN body — so
 * the card is leak-proof regardless of field order or country format. The
 * "****<last4>" form matches the last-4 convention banks use on receipts.
 *
 * When the destination is empty (cold-start draft, before the sender enters bank
 * details on the secure pay page) the bank line shows the placeholder instead.
 */
function maskDestination(method: PayoutMethod, dest: string): string {
  if (method === 'upi' && dest) return `UPI ${dest}`;
  const last4 = accountLast4(dest);
  return last4 ? `bank a/c ****${last4}` : NO_BANK_DETAILS_PLACEHOLDER;
}

/**
 * Builds the enriched single-message body for the approve/cancel interactive.
 * Pure function; no I/O. Exported for unit-testing.
 *
 * destinationCurrency defaults to 'INR' for full back-compat — INR quotes render
 * identically to before (Intl en-US INR → "₹83", "₹41,500").
 */
export function buildApproveSummary(
  q: import('./types').Quote,
  recipientName: string,
  payoutMethod: PayoutMethod,
  payoutDestination: string,
  fundingMethod: FundingMethod,
  destinationCurrency: CurrencyCode = 'INR',
): string {
  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: q.sourceCurrency }).format(n);
  // Generic destination-currency formatter (works for AED, GBP, INR, …).
  // For INR with en-US locale: Intl renders "₹83" / "₹41,500" — identical to the
  // previous `₹${n.toLocaleString('en-IN')}` for the integers we use here.
  const fmtDest = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: destinationCurrency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(n);

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
    `Rate: 1 ${q.sourceCurrency} = ${fmtDest(q.fxRate)}`,
    `They get ${fmtDest(q.amountInr)} ${q.deliveryEstimate}.`,
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
              "Optional. The exact rupee amount the RECIPIENT should receive. Provide this INSTEAD of amount_usd ONLY when no send amount has been set yet, or after the user has explicitly confirmed switching to a receive-first amount (see the SEND AMOUNT LOCK rule). If a send amount is already locked in this flow, do NOT pass amount_inr until the user has confirmed the change. We back-solve the send amount and add the fee on top. If both are given, amount_inr wins.",
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
          destination_country: {
            type: 'string',
            description:
              "ISO country code of where the money is going, e.g. 'IN','AE','GB','US'. Defaults to India.",
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
          destination_country: {
            type: 'string',
            description: "ISO country code of where the money is going, e.g. 'IN','AE','GB','US'. Defaults to India.",
          },
        },
        required: [
          'amount_usd',
          'recipient_name',
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
          end_date: {
            type: 'string',
            description: 'Optional ISO date (YYYY-MM-DD) after which the schedule stops. Omit for no end date.',
          },
          recipient_legal_name: { type: 'string', description: 'Recipient legal name (only when enhanced verification is required).' },
          relationship: { type: 'string', enum: ['self','spouse','parent','child','sibling','other_family','friend','business','other'] },
          purpose: { type: 'string', enum: ['family_support','gift','education','medical','savings','bills','business','other'] },
          source_of_funds: { type: 'string', enum: ['employment','business','investment','gift','savings','other'] },
          occupation: { type: 'string', enum: ['salaried','self_employed','business_owner','student','homemaker','retired','unemployed','other'] },
        },
        required: ['amount_usd', 'recipient_name', 'recipient_phone', 'funding_method', 'frequency'],
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
        "Lock the quote and send the sender an [Approve & pay] button. Call this when you have the amount, funding method, recipient name, destination country, and recipient phone. Do NOT collect bank details — the sender enters the recipient's bank details on the secure pay page. For a saved/known recipient (repeat or scheduled), the system reuses the stored payout details automatically.",
      parameters: {
        type: 'object',
        properties: {
          amount_usd: { type: 'number', description: "Amount to send, in the sender's send currency (US dollars unless told otherwise)." },
          funding_method: { type: 'string', enum: ['credit_card', 'debit_card', 'bank_transfer'] },
          recipient_name: { type: 'string' },
          recipient_phone: { type: 'string' },
          source_currency: {
            type: 'string',
            description:
              "The currency the sender is sending in, e.g. 'USD' or 'GBP'. Only provide when you have been told more than one is available; otherwise omit it.",
          },
          destination_country: {
            type: 'string',
            description: "ISO country code of where the money is going, e.g. 'IN','AE','GB','US'. Defaults to India.",
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
  {
    type: 'function',
    function: {
      name: 'resolve_recipient',
      description:
        "Look up the sender's saved recipients by a name they typed (e.g. 'Mom'). Returns { match: 'exact', recipient } when exactly one saved recipient matches — use its payout_method, payout_destination, and recipient_phone directly (do not re-ask). Returns { match: 'ambiguous', candidates } when more than one could match — call send_recipient_picker with the candidates. Returns { match: 'none' } when nothing matches — ask for the recipient's number and payout details.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The recipient name the user typed, e.g. 'Mom'." },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repeat_transfer',
      description:
        "Re-send to a recipient the sender has paid before, reusing that recipient's saved payout details and last amount. Use ONLY when the customer asks to repeat ('send the usual', 'send Mom again', 'same as last time'). amount_usd overrides the last amount; funding_method overrides the remembered method. It re-checks the cap and routes to the [Approve & pay] card — it never moves money without that confirmation. If it returns needs_edd: true, ask the source-of-funds + occupation questions, then call send_approve_picker with all the details it returned plus those two fields.",
      parameters: {
        type: 'object',
        properties: {
          recipient_phone: { type: 'string', description: "The recipient's WhatsApp number, from a past transfer (e.g. 919876543210)." },
          amount_usd: { type: 'number', description: 'Optional. New amount in the send currency; if omitted, reuse the last amount sent to this recipient.' },
          funding_method: { type: 'string', enum: ['credit_card', 'debit_card', 'bank_transfer'], description: "Optional. Defaults to the sender's remembered method, then the last transfer's method." },
        },
        required: ['recipient_phone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'capture_corridor_request',
      description:
        "Capture a lead when a user wants to send to a country we don't deliver to yet (any country outside the 8 supported: US, Canada, UK, UAE, Singapore, Australia, New Zealand, India). Saves their destination + rough amount for the team. PRECONDITION: only call this AFTER you have already told the customer, as the FIRST sentence of your reply, that we don't deliver to that country yet and listed the 8 supported countries. Never call this before that limitation sentence, and never let needing an approx_amount make you open with a 'how much' question.",
      parameters: {
        type: 'object',
        properties: {
          destination_country: {
            type: 'string',
            description: 'The destination country the user mentioned (e.g. "UAE", "Pakistan").',
          },
          approx_amount: {
            type: 'number',
            description: 'Optional. Approximately how much the user wants to send.',
          },
          approx_currency: {
            type: 'string',
            description: 'Optional. The currency for the approximate amount (e.g. "USD", "AED").',
          },
        },
        required: ['destination_country'],
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
  waCreds?: WaCreds; // WL2 — partner's outbound WhatsApp creds (absent ⇒ shared env number)
}

type ToolResult = Record<string, unknown>;

// Valid CountryCode set for runtime validation (must match the union in types.ts).
const VALID_COUNTRY_CODES: ReadonlySet<string> = new Set<CountryCode>([
  'US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN',
]);

// Resolves the customer (upsert on first contact), their partner, the send
// currency for that partner, fresh FX rates, AND the destination country/currency.
// destinationCountryArg is validated against the CountryCode union; unknown values
// fall back to 'IN' (India) so the default US→India path is unchanged.
async function resolveCurrencyAndRates(
  ctx: ToolContext,
  requested: unknown,
  destinationCountryArg?: unknown,
): Promise<{
  customer: Customer;
  partner: Partner;
  sourceCurrency: CurrencyCode;
  rates: FxRates;
  destinationCountry: CountryCode;
  destinationCurrency: CurrencyCode;
  destToUsd: number;
}> {
  const customer =
    (await ctx.customerStore.getCustomer(ctx.phone)) ??
    (await ctx.customerStore.upsertOnFirstInbound(ctx.phone)).customer;
  const partner =
    (await ctx.partnerStore.getPartner(customer.partnerId)) ??
    (await ctx.partnerStore.ensureDefaultPartner());
  const sourceCurrency = resolveSendCurrency(
    partner,
    typeof requested === 'string' ? requested : undefined,
    ctx.phone,
  );
  const rates = await getFxRates(sourceCurrency);

  // Destination resolution — validated; unknown country code → 'IN' (back-compat).
  const destinationCountry: CountryCode =
    typeof destinationCountryArg === 'string' &&
    VALID_COUNTRY_CODES.has(destinationCountryArg.toUpperCase())
      ? (destinationCountryArg.toUpperCase() as CountryCode)
      : 'IN';
  const destinationCurrency = DEFAULT_CURRENCY_FOR_COUNTRY[destinationCountry];
  const destRates = await getFxRates(destinationCurrency);

  return { customer, partner, sourceCurrency, rates, destinationCountry, destinationCurrency, destToUsd: destRates.toUsd };
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
    case 'resolve_recipient':
      return resolveRecipientTool(args, ctx);
    case 'repeat_transfer':
      return repeatTransferTool(args, ctx);
    case 'capture_corridor_request':
      return captureCorridorRequestTool(args, ctx);
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
    const { customer, partner, sourceCurrency, rates, destinationCountry, destinationCurrency, destToUsd } =
      await resolveCurrencyAndRates(ctx, args.source_currency, args.destination_country);

    // Phase 3 verify-before-send gate — a NEW condition on kycStatus, independent
    // of the existing T0/Suspended cap branch below. Hand off the kyc_url before
    // building any quote so the bot directs the customer to verify first.
    // WL1: skipped for a 'delegated' partner (they run KYC). Sanctions unaffected.
    if (sendGateActive(partner) && !isSendVerified(customer)) {
      const start = await ctx.kycProvider.startVerification({
        customerId: ctx.phone,
        senderPhone: ctx.phone,
      });
      return { within_cap: false, reason: SEND_GATE_REASON, kyc_url: start.url };
    }

    // Receive-first (Win A): when a finite, positive target rupee amount is
    // given, back-solve the send amount; the recipient gets exactly that INR
    // and the fee is added on top (today's model). amount_inr wins over
    // amount_usd. Otherwise this is byte-for-byte today's send-first path.
    const targetInr = Number(args.amount_inr);
    const amountSource =
      Number.isFinite(targetInr) && targetInr > 0
        ? sourceForInr(targetInr, rates)
        : Number(args.amount_usd);

    // Cap/tier guard (Bundle D) — refuse BEFORE quoting so the bot never presents
    // an unfulfillable quote. Mirrors check_send_limit's cap result (caps-only; EDD
    // is unchanged and stays on check_send_limit). Runs on the resolved amountSource,
    // so it covers the amount_inr (receive-first) path too. Only when the amount is
    // finite — a missing/NaN amount falls through to quote()'s "valid amount" error.
    const amountUsd = Math.round(amountSource * rates.toUsd * 100) / 100;
    if (Number.isFinite(amountUsd)) {
      const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
      const ev = evaluateCap(customer, new Date(), todayUsedCents, Math.round(amountUsd * 100), sendGateActive(partner));
      if (!ev.withinCap) {
        let kycUrl: string | undefined;
        if (ev.tier === 'T0' || ev.tier === 'Suspended') {
          const start = await ctx.kycProvider.startVerification({
            customerId: ctx.phone,
            senderPhone: ctx.phone,
          });
          kycUrl = start.url;
        }
        return {
          within_cap: false,
          tier: ev.tier,
          reason: ev.reason,
          daily_cap_usd: ev.dailyCapCents / 100,
          per_transfer_cap_usd: ev.perTransferCapCents / 100,
          today_used_usd: ev.todayUsedCents / 100,
          today_remaining_usd: ev.todayRemainingCents / 100,
          day_of_window: ev.dayOfWindow,
          kyc_url: kycUrl,
        };
      }
    }

    // G: default funding_method to bank_transfer when absent
    const fundingMethod = (args.funding_method as FundingMethod | undefined) ?? 'bank_transfer';

    const q = quote(
      amountSource,
      sourceCurrency,
      rates,
      fundingMethod,
      transferCount,
      destinationCurrency,
      destToUsd,
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
      amount_inr: q.amountInr,           // back-compat field (= amount in destination currency)
      amount_dest: q.amountInr,          // clear alias for non-India destinations
      destination_currency: q.destinationCurrency,
      destination_country: destinationCountry,
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
    // WL1: resolve the owning partner once (drives both the gate toggle below and
    // requiresKyc into createTransfer). Default/'ours' ⇒ gate ON (unchanged).
    const partner =
      (await ctx.partnerStore.getPartner(customer.partnerId)) ??
      (await ctx.partnerStore.ensureDefaultPartner());
    // Phase 3 verify-before-send gate (last bot chokepoint before mint).
    if (sendGateActive(partner) && !isSendVerified(customer)) {
      const start = await ctx.kycProvider.startVerification({ customerId: ctx.phone, senderPhone: ctx.phone });
      return { error: 'Identity verification required before sending.', reason: SEND_GATE_REASON, kyc_required: true, kyc_url: start.url };
    }
    {
      const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
      const requestedCents = Math.round(draft.amountUsd * 100);
      const ev = evaluateCap(customer, new Date(), todayUsedCents, requestedCents, sendGateActive(partner));
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
        destinationCountry: draft.destinationCountry,
        destinationCurrency: draft.destinationCurrency,
        partnerId: customer.partnerId ?? DEFAULT_PARTNER_ID,
        recipientName: draft.recipient.name,
        recipientPhone: draft.recipient.recipientPhone,
        payoutMethod: draft.recipient.payoutMethod,
        payoutDestination: draft.recipient.payoutDestination ?? '',
        fundingMethod: draft.fundingMethod,
        // ── KYC Travel-Rule / EDD: from the consumed draft + sender legal name ──
        recipientLegalName: draft.recipientLegalName,
        relationship: draft.relationship,
        purpose: draft.purpose,
        sourceOfFunds: draft.sourceOfFunds,
        occupation: draft.occupation,
        senderName: customer.fullName,
        senderKycStatus: customer.kycStatus,
        requiresKyc: sendGateActive(partner), // WL1: delegated ⇒ false; sanctions still run
      });
      await ctx.dailyVolumeStore.addCents(ctx.phone, Math.round(transfer.amountUsd * 100));
      await persistEddProfile(ctx, customer, draft.sourceOfFunds, draft.occupation);
      await ctx.customerStore.recordFundingMethod(ctx.phone, draft.fundingMethod);
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
  const { customer: legacyCustomer, partner: legacyPartner, sourceCurrency, rates, destinationCountry: legacyDestCountry, destinationCurrency: legacyDestCurrency } = await resolveCurrencyAndRates(
    ctx,
    args.source_currency,
    args.destination_country,
  );
  // Phase 3 verify-before-send gate (legacy explicit-args create path).
  // WL1: skipped for a 'delegated' partner; sanctions still run in createTransfer.
  if (sendGateActive(legacyPartner) && !isSendVerified(legacyCustomer)) {
    const start = await ctx.kycProvider.startVerification({ customerId: ctx.phone, senderPhone: ctx.phone });
    return { error: 'Identity verification required before sending.', reason: SEND_GATE_REASON, kyc_required: true, kyc_url: start.url };
  }
  const amountSource = Number(args.amount_usd);
  const amountUsd = Math.round(amountSource * rates.toUsd * 100) / 100;
  // Cap check on the legacy path (cron-fired or no-button cold-start)
  {
    const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
    const requestedCents = Math.round(amountUsd * 100);
    const ev = evaluateCap(legacyCustomer, new Date(), todayUsedCents, requestedCents, sendGateActive(legacyPartner));
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
      destinationCountry: legacyDestCountry,
      destinationCurrency: legacyDestCurrency,
      partnerId: legacyCustomer.partnerId ?? DEFAULT_PARTNER_ID,
      recipientName: String(args.recipient_name),
      recipientPhone,
      payoutMethod: (args.payout_method as PayoutMethod | undefined) ?? 'bank',
      // Item 2: bank details come from the secure pay page; legacy reads default to ''.
      payoutDestination: typeof args.payout_destination === 'string' ? args.payout_destination : '',
      fundingMethod: (args.funding_method as FundingMethod | undefined) ?? 'bank_transfer',
      // ── KYC Travel-Rule / EDD: validated from args + sender legal name ──
      recipientLegalName: typeof args.recipient_legal_name === 'string' ? args.recipient_legal_name : undefined,
      relationship: asEnum(RELATIONSHIPS, args.relationship),
      purpose: asEnum(PURPOSES, args.purpose),
      sourceOfFunds: legacySof,
      occupation: legacyOcc,
      senderName: legacyCustomer.fullName,
      senderKycStatus: legacyCustomer.kycStatus,
      requiresKyc: sendGateActive(legacyPartner), // WL1: delegated ⇒ false; sanctions still run
    });
    await ctx.dailyVolumeStore.addCents(ctx.phone, Math.round(transfer.amountUsd * 100));
    await persistEddProfile(ctx, legacyCustomer, legacySof, legacyOcc);
    await ctx.customerStore.recordFundingMethod(ctx.phone, args.funding_method as FundingMethod);
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
  // Validate optional end_date: must be a parseable ISO date string; ignore if not.
  let endDate: string | undefined;
  if (typeof args.end_date === 'string' && args.end_date.trim() !== '') {
    const parsed = Date.parse(args.end_date.trim());
    if (!isNaN(parsed)) {
      endDate = args.end_date.trim();
    }
  }
  const schedule: Schedule = {
    id: newTransferId(),
    phone: ctx.phone,
    amountUsd: amountSource, // kept as source amount (USD-equivalent when USD; else raw source)
    recipientName: String(args.recipient_name),
    recipientPhone,
    payoutMethod: (args.payout_method as Schedule['payoutMethod'] | undefined) ?? 'bank',
    // Item 2: bank details come from the secure pay page; legacy reads default to ''.
    payoutDestination: typeof args.payout_destination === 'string' ? args.payout_destination : '',
    fundingMethod: (args.funding_method as Schedule['fundingMethod'] | undefined) ?? 'bank_transfer',
    frequency,
    dayOfMonth,
    dayOfWeek,
    status: 'active',
    createdAt: new Date().toISOString(),
    endDate,
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
    end_date: schedule.endDate ?? null,
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
        payout_destination: maskAccount(r.payoutMethod, r.payoutDestination),
        last_used_at: r.lastUsedAt,
      })),
    };
  } catch (err) {
    console.warn('listRecipients failed; returning []:', err);
    return { recipients: [] };
  }
}

async function resolveRecipientTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = String(args.name ?? '').trim().toLowerCase();
  if (!query) return { match: 'none' };

  let all: import('./types').Recipient[];
  try {
    all = await ctx.store.listRecipients(ctx.phone, 25); // generous cap; own-phone only
  } catch (err) {
    console.warn('resolve_recipient listRecipients failed:', err);
    return { match: 'none' };
  }

  // Customer-owned fields only — never partner/compliance/PII.
  // payout_destination is masked so the LLM never sees a raw account number.
  const shape = (r: import('./types').Recipient) => ({
    name: r.name,
    recipient_phone: r.recipientPhone,
    payout_method: r.payoutMethod,
    payout_destination: maskAccount(r.payoutMethod, r.payoutDestination),
  });
  const norm = (s: string) => (s ?? '').trim().toLowerCase();

  const exact = all.filter((r) => norm(r.name) === query);
  if (exact.length === 1) return { match: 'exact', recipient: shape(exact[0]) };

  // Ambiguous: >1 exact match, or only partial (either-direction substring) matches.
  // A partial match alone NEVER auto-proceeds — exact-1 is the only fast path.
  const candidates = (
    exact.length > 1
      ? exact
      : all.filter((r) => {
          const n = norm(r.name);
          return n.includes(query) || query.includes(n);
        })
  ).slice(0, 3); // WhatsApp reply-button cap

  if (candidates.length === 0) return { match: 'none' };
  return { match: 'ambiguous', candidates: candidates.map(shape) };
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
    ctx.waCreds, // WL2 — picker leaves from the partner's number
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
  // G: default funding_method to bank_transfer when absent
  const fundingMethod = (args.funding_method as FundingMethod | undefined) ?? 'bank_transfer';
  // Item 2: bank details are entered on the secure pay page, not collected in
  // chat. On a cold start the LLM passes no payout fields → method 'bank',
  // destination ''. When a saved recipient is reused (repeat_transfer /
  // resolve_recipient), those args ARE supplied and we keep them verbatim.
  const payoutMethod: PayoutMethod = (args.payout_method as PayoutMethod | undefined) ?? 'bank';
  const payoutDestination = typeof args.payout_destination === 'string' ? args.payout_destination : '';
  // Resolve currency+rates+destination ONCE; reuse `customer` for the cap check (no second getCustomer).
  const { customer, partner, sourceCurrency, rates, destinationCountry, destinationCurrency, destToUsd } =
    await resolveCurrencyAndRates(ctx, args.source_currency, args.destination_country);
  // Phase 3 verify-before-send gate — refuse to build the approval card / draft
  // for an unverified sender; hand off the kyc_url instead.
  // WL1: skipped for a 'delegated' partner; sanctions still run at mint time.
  if (sendGateActive(partner) && !isSendVerified(customer)) {
    const start = await ctx.kycProvider.startVerification({ customerId: ctx.phone, senderPhone: ctx.phone });
    return { error: 'Identity verification required before sending.', reason: SEND_GATE_REASON, kyc_required: true, kyc_url: start.url };
  }
  const amountSource = Number(args.amount_usd);
  const amountUsd = Math.round(amountSource * rates.toUsd * 100) / 100;
  // Cap enforcement (defense in depth — check_send_limit + this + create_transfer)
  {
    const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
    const requestedCents = Math.round(amountUsd * 100);
    const ev = evaluateCap(customer, new Date(), todayUsedCents, requestedCents, sendGateActive(partner));
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
  // Screen at card-show (read-only) BEFORE creating the draft. Quote first so a
  // blocked attempt is recorded with real figures.
  const transfersToday = await ctx.store.getTodayTransferCount(ctx.phone);
  try {
    const transferCount = await ctx.store.getTransferCount(ctx.phone);
    const q = quote(amountSource, sourceCurrency, rates, fundingMethod, transferCount, destinationCurrency, destToUsd);

    const screen = await screenTransfer({
      amountUsd,
      recipientName: String(args.recipient_name),
      transfersToday,
      sourceCountry: customer.senderCountry,
      senderName: customer.fullName,
    });
    if (screen.status === 'blocked') {
      // Record an auditable, never-charged blocked row (no velocity/volume bump).
      try {
        await recordBlockedAttempt(ctx.store, {
          phone: ctx.phone,
          recipientName: String(args.recipient_name),
          recipientPhone,
          payoutMethod,
          // Item 2: bank details aren't collected in chat — the screener matches
          // on name, not the account number — so a blocked attempt records ''.
          payoutDestination,
          fundingMethod,
          amountUsd: q.amountUsd,
          amountSource: q.amountSource,
          sourceCurrency: q.sourceCurrency,
          feeUsd: q.feeUsd,
          feeSource: q.feeSource,
          fxRate: q.fxRate,
          amountInr: q.amountInr,
          totalChargeUsd: q.totalChargeUsd,
          totalChargeSource: q.totalChargeSource,
          destinationCountry,
          destinationCurrency,
          partnerId: customer.partnerId,
          reasons: screen.reasons,
        });
      } catch (err) {
        console.warn('recordBlockedAttempt failed (non-fatal):', err);
      }
      return {
        blocked: true,
        reply_to_customer:
          "This transfer can't be completed, and our team has been notified. If you have any questions, reply 'help' and we'll follow up.",
      };
    }

    const draftId = await ctx.draftStore.createDraft({
      senderPhone: ctx.phone,
      recipient: {
        name: String(args.recipient_name),
        recipientPhone,
        payoutMethod,
        payoutDestination,
      },
      amountUsd: q.amountUsd,
      amountSource: q.amountSource,
      sourceCurrency: q.sourceCurrency,
      destinationCountry,
      destinationCurrency,
      fundingMethod,
      // ── KYC Travel-Rule / EDD enums (validated; unknown ⇒ unsupplied) ──
      recipientLegalName: typeof args.recipient_legal_name === 'string' ? args.recipient_legal_name : undefined,
      relationship: asEnum(RELATIONSHIPS, args.relationship),
      purpose: asEnum(PURPOSES, args.purpose),
      sourceOfFunds: asEnum(SOURCE_OF_FUNDS, args.source_of_funds),
      occupation: asEnum(OCCUPATIONS, args.occupation),
      quote: {
        feeUsd: q.feeUsd,
        fxRate: q.fxRate,
        amountInr: q.amountInr,
        feeSource: q.feeSource,
        totalChargeSource: q.totalChargeSource,
        totalChargeUsd: q.totalChargeUsd,
        destinationCurrency: q.destinationCurrency,
      },
    });
    const summary = buildApproveSummary(
      q,
      String(args.recipient_name),
      payoutMethod,
      payoutDestination,
      fundingMethod,
      q.destinationCurrency ?? 'INR',
    );
    const payUrl = `${env.appBaseUrl}/pay/${draftId}`;
    await sendCtaUrl(
      ctx.phone,
      `${summary}\n\nTap to pay securely, or reply cancel to stop.`,
      { displayText: 'Approve & Pay', url: payUrl },
      undefined,
      undefined,
      ctx.waCreds, // WL2 — approve card leaves from the partner's number
    );
    return { sent: true, draft_id: draftId };
  } catch (err) {
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
}

async function repeatTransferTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const recipientPhone = normalizePhone(args.recipient_phone);
  if (!isValidPhone(recipientPhone)) {
    return { error: "I need the recipient's WhatsApp number to repeat a transfer." };
  }

  // Hydrate the most-recent transfer to this recipient (own phone, newest-first).
  // Stage 4: indexed per-phone page, then a small in-JS recipient filter.
  const mine = (await ctx.store.listTransfersByPhone(ctx.phone, 100)).filter(
    (t) => t.recipientPhone === recipientPhone,
  );
  const last = mine[0];
  if (!last) {
    return { error: "I don't see a past transfer to that number — who would you like to send to?" };
  }

  // The default ledger read MASKS payout destinations (****last4) — a repeat
  // must carry the REAL account into the new draft. Hydrate it from the saved
  // recipient (decrypted), else a decrypted read of that exact transfer.
  const savedRecipient = (await ctx.store.listRecipients(ctx.phone, 25)).find(
    (r) => normalizePhone(r.recipientPhone) === recipientPhone,
  );
  const realPayoutDestination =
    savedRecipient?.payoutDestination ||
    (await ctx.store.getTransferDecrypted(last.id))?.payoutDestination ||
    '';

  // Amount + funding fallback chain.
  const overrideAmount = Number(args.amount_usd);
  const amountSource =
    Number.isFinite(overrideAmount) && overrideAmount > 0
      ? overrideAmount
      : last.amountSource ?? last.amountUsd;
  const customer = await ctx.customerStore.getCustomer(ctx.phone);
  const fundingMethod =
    (args.funding_method as FundingMethod | undefined) ??
    customer?.lastFundingMethod ??
    last.fundingMethod;

  // Defense-in-depth cap + EDD re-check on the REAL amount — the same gate the
  // normal flow runs before quoting. EDD must be collected BEFORE the approval
  // card, so on edd_required we return the hydrated details and let the model ask,
  // rather than sending the card.
  const limit = await checkSendLimitTool(
    { amount_usd: amountSource, source_currency: last.sourceCurrency },
    ctx,
  );
  if (limit.within_cap === false) {
    return { error: 'That repeat would exceed your current sending cap.', cap_eval: limit };
  }
  if (limit.edd_required === true) {
    return {
      needs_edd: true,
      edd_threshold_usd: limit.edd_threshold_usd,
      amount_usd: amountSource,
      source_currency: last.sourceCurrency,
      funding_method: fundingMethod,
      recipient_name: last.recipientName,
      recipient_phone: recipientPhone,
      payout_method: last.payoutMethod,
      payout_destination: realPayoutDestination,
    };
  }

  // Route through the EXISTING approve-card path (cap re-check, quote, draft,
  // [Approve & pay] card). Never calls create_transfer directly — compliance
  // re-screens at approval exactly like any other send.
  return sendApprovePickerTool(
    {
      amount_usd: amountSource,
      funding_method: fundingMethod,
      recipient_name: last.recipientName,
      recipient_phone: recipientPhone,
      payout_method: last.payoutMethod,
      payout_destination: realPayoutDestination,
      source_currency: last.sourceCurrency,
    },
    ctx,
  );
}

async function cancelDraftTool(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Prefer the legacy Cancel-button tap context; otherwise fall back to the
  // per-phone active-draft pointer. The one-tap CTA pay flow has no Cancel
  // button, so a typed/spoken "cancel" routes here with no buttonTap.
  const draftId =
    ctx.turn.buttonTap?.kind === 'cancel'
      ? ctx.turn.buttonTap.draftId
      : await ctx.draftStore.getActiveDraftId(ctx.phone);
  if (!draftId) {
    return { cancelled: false, reason: 'no_active_draft' };
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

async function captureCorridorRequestTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const destinationCountry = String(args.destination_country ?? '').trim();
  if (!destinationCountry) return { error: 'destination_country is required.' };
  const amt = Number(args.approx_amount);
  const req: import('./types').CorridorRequest = {
    id: newTransferId(),
    senderPhone: ctx.phone,
    destinationCountry,
    approxAmount: Number.isFinite(amt) && amt > 0 ? amt : undefined,
    approxCurrency: typeof args.approx_currency === 'string' ? args.approx_currency.toUpperCase() : undefined,
    capturedAt: new Date().toISOString(),
  };
  await ctx.store.saveCorridorRequest(req);
  return { saved: true, request_id: req.id };
}

async function checkSendLimitTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Resolve currency+rates and reuse `customer` — no second getCustomer.
  const { customer, partner, rates } = await resolveCurrencyAndRates(ctx, args.source_currency);
  // Phase 3 verify-before-send gate — direct the customer to verify BEFORE the
  // cap/EDD logic. A NEW condition on kycStatus, independent of the T0/Suspended
  // branch below (which is left intact). WL1: skipped for a 'delegated' partner.
  if (sendGateActive(partner) && !isSendVerified(customer)) {
    const start = await ctx.kycProvider.startVerification({ customerId: ctx.phone, senderPhone: ctx.phone });
    return { within_cap: false, reason: SEND_GATE_REASON, kyc_url: start.url };
  }
  const amountSource = Number(args.amount_usd ?? 0);
  // Convert to USD-equivalent for the cap evaluation (for USD partners toUsd===1).
  const amountUsd = Math.round(amountSource * rates.toUsd * 100) / 100;
  const requestedCents = Math.round(amountUsd * 100);
  const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
  const evalResult = evaluateCap(customer, new Date(), todayUsedCents, requestedCents, sendGateActive(partner));

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
