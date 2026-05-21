import { quote, QuoteError } from './fx';
import { getFxRate } from './rate';
import { newTransferId } from './id';
import { env } from './env';
import { normalizePhone, isValidPhone } from './phone';
import type { ChatTool, FundingMethod, PayoutMethod, Transfer } from './types';
import type { Store } from './store';

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
            description: 'Amount to send, in US dollars.',
          },
          funding_method: {
            type: 'string',
            enum: ['credit_card', 'debit_card', 'bank_transfer'],
            description:
              "How the sender pays: 'credit_card', 'debit_card', or 'bank_transfer'. The fee depends on this choice.",
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
          amount_usd: { type: 'number' },
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
];

export interface ToolContext {
  phone: string;
  store: Store;
}

type ToolResult = Record<string, unknown>;

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
    const fxRate = await getFxRate();
    const q = quote(
      Number(args.amount_usd),
      fxRate,
      args.funding_method as FundingMethod,
      transferCount,
    );
    return {
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
  try {
    const recipientPhone = normalizePhone(args.recipient_phone);
    if (!isValidPhone(recipientPhone)) {
      return {
        error:
          'A valid recipient WhatsApp number with country code is required before creating the transfer. Ask the user for it (e.g. 919876543210).',
      };
    }

    const transferCount = await ctx.store.getTransferCount(ctx.phone);
    const payoutMethod = args.payout_method as PayoutMethod;
    const fundingMethod = args.funding_method as FundingMethod;
    const fxRate = await getFxRate();
    const q = quote(Number(args.amount_usd), fxRate, fundingMethod, transferCount);
    const transfer: Transfer = {
      id: newTransferId(),
      phone: ctx.phone,
      amountUsd: q.amountUsd,
      feeUsd: q.feeUsd,
      totalChargeUsd: q.totalChargeUsd,
      fxRate: q.fxRate,
      amountInr: q.amountInr,
      recipientName: String(args.recipient_name),
      recipientPhone,
      payoutMethod,
      payoutDestination: String(args.payout_destination),
      fundingMethod,
      status: 'awaiting_payment',
      createdAt: new Date().toISOString(),
    };
    await ctx.store.saveTransfer(transfer);
    await ctx.store.incrementTransferCount(ctx.phone);
    return {
      transfer_id: transfer.id,
      status: transfer.status,
      amount_inr: transfer.amountInr,
      total_charge_usd: transfer.totalChargeUsd,
      recipient_name: transfer.recipientName,
    };
  } catch (err) {
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
}

async function generatePaymentLinkTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const transfer = await ctx.store.getTransfer(String(args.transfer_id));
  if (!transfer) return { error: 'Transfer not found.' };
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
