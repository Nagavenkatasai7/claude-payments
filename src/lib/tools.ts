import { quote, QuoteError } from './fx';
import { getFxRate } from './rate';
import { newTransferId } from './id';
import { env } from './env';
import { normalizePhone, isValidPhone } from './phone';
import { createTransfer } from './transfer-create';
import type { ScheduleStore } from './schedule-store';
import type { ChatTool, FundingMethod, PayoutMethod, Schedule } from './types';
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
  {
    type: 'function',
    function: {
      name: 'create_schedule',
      description:
        'Set up a recurring transfer that repeats monthly or weekly. Collect all recipient details first, just like create_transfer.',
      parameters: {
        type: 'object',
        properties: {
          amount_usd: { type: 'number' },
          recipient_name: { type: 'string' },
          recipient_phone: { type: 'string', description: "Recipient's WhatsApp number with country code." },
          payout_method: { type: 'string', enum: ['upi', 'bank'] },
          payout_destination: { type: 'string' },
          funding_method: { type: 'string', enum: ['credit_card', 'debit_card', 'bank_transfer'] },
          frequency: { type: 'string', enum: ['monthly', 'weekly'] },
          day_of_month: { type: 'number', description: 'Day 1-28, required when frequency is monthly.' },
          day_of_week: { type: 'number', description: 'Day 0 (Sunday) to 6 (Saturday), required when frequency is weekly.' },
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
];

export interface ToolContext {
  phone: string;
  store: Store;
  scheduleStore: ScheduleStore;
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
    case 'create_schedule':
      return createScheduleTool(args, ctx);
    case 'list_schedules':
      return listSchedulesTool(args, ctx);
    case 'cancel_schedule':
      return cancelScheduleTool(args, ctx);
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
  const recipientPhone = normalizePhone(args.recipient_phone);
  if (!isValidPhone(recipientPhone)) {
    return {
      error:
        'A valid recipient WhatsApp number with country code is required before creating the transfer. Ask the user for it (e.g. 919876543210).',
    };
  }
  try {
    const transfer = await createTransfer(ctx.store, {
      phone: ctx.phone,
      amountUsd: Number(args.amount_usd),
      recipientName: String(args.recipient_name),
      recipientPhone,
      payoutMethod: args.payout_method as PayoutMethod,
      payoutDestination: String(args.payout_destination),
      fundingMethod: args.funding_method as FundingMethod,
    });
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
  const schedule: Schedule = {
    id: newTransferId(),
    phone: ctx.phone,
    amountUsd: Number(args.amount_usd),
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
