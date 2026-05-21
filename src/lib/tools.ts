import { quote, QuoteError } from './fx';
import { newTransferId } from './id';
import { env } from './env';
import type { ChatTool, PayoutMethod, Transfer } from './types';
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
          payout_method: {
            type: 'string',
            enum: ['upi', 'bank'],
            description: "How the recipient is paid: 'upi' or 'bank'.",
          },
        },
        required: ['amount_usd', 'payout_method'],
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
        },
        required: [
          'amount_usd',
          'recipient_name',
          'payout_method',
          'payout_destination',
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_payment_link',
      description:
        'Generate the secure link where the user enters card details to pay.',
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
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function getQuoteTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const user = await ctx.store.getUser(ctx.phone);
    const q = quote(
      Number(args.amount_usd),
      args.payout_method as PayoutMethod,
      user.transferCount,
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
    const user = await ctx.store.getUser(ctx.phone);
    const payoutMethod = args.payout_method as PayoutMethod;
    const q = quote(Number(args.amount_usd), payoutMethod, user.transferCount);
    const transfer: Transfer = {
      id: newTransferId(),
      phone: ctx.phone,
      amountUsd: q.amountUsd,
      feeUsd: q.feeUsd,
      totalChargeUsd: q.totalChargeUsd,
      fxRate: q.fxRate,
      amountInr: q.amountInr,
      recipientName: String(args.recipient_name),
      payoutMethod,
      payoutDestination: String(args.payout_destination),
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
