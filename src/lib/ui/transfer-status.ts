import type { Transfer, TransferStatus } from '@/lib/types';
import type { MessageKey } from '@/lib/i18n';

// The ONE transfer-status mapping for new UI: label key (never the raw status token), tone and icon.
// Labels equal the customer portal's (tests/i18n.test.ts); the danger tone agrees with its badges.
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export type StatusIcon = 'clock' | 'check' | 'alert' | 'x' | 'refund';
export type TransferStatusView = { labelKey: MessageKey; tone: Tone; icon: StatusIcon };

const BASE: Record<TransferStatus, { tone: Tone; icon: StatusIcon }> = {
  awaiting_payment: { tone: 'info', icon: 'clock' },
  paid: { tone: 'info', icon: 'check' },
  in_review: { tone: 'warning', icon: 'alert' },
  delivered: { tone: 'success', icon: 'check' },
  cancelled: { tone: 'neutral', icon: 'x' },
  blocked: { tone: 'danger', icon: 'alert' },
};

export function transferStatusView(t: Pick<Transfer, 'status' | 'refundStatus'>): TransferStatusView {
  const r = t.refundStatus;
  // An active or settled refund replaces the base label; 'none' / 'failed' fall through (as in the portal).
  if (r === 'requested' || r === 'pending' || r === 'completed') {
    return { labelKey: `status.refund.${r}`, tone: r === 'completed' ? 'neutral' : 'info', icon: 'refund' };
  }
  const base = Object.hasOwn(BASE, t.status) ? BASE[t.status] : undefined;
  if (!base) return { labelKey: 'status.transfer.unknown', tone: 'neutral', icon: 'clock' };
  return { labelKey: `status.transfer.${t.status}`, ...base };
}
