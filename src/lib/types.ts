export type PayoutMethod = 'upi' | 'bank';

export type TransferStatus = 'awaiting_payment' | 'paid' | 'delivered';

export interface Quote {
  amountUsd: number;
  feeUsd: number;
  totalChargeUsd: number;
  fxRate: number;
  amountInr: number;
  deliveryEstimate: string;
}

export interface Transfer {
  id: string;
  phone: string;
  amountUsd: number;
  feeUsd: number;
  totalChargeUsd: number;
  fxRate: number;
  amountInr: number;
  recipientName: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  status: TransferStatus;
  createdAt: string;
  paidAt?: string;
  deliveredAt?: string;
}

export interface UserRecord {
  transferCount: number;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  // OpenAI-compatible APIs return null content when an assistant message
  // carries tool_calls instead of text.
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
