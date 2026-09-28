import { Check, Clock, RotateCcw, TriangleAlert, X } from 'lucide-react';
import type { RefundStatus, TransferStatus } from '@/lib/types';
import { t } from '@/lib/i18n';
import { transferStatusView, type StatusIcon } from '@/lib/ui/transfer-status';
import { Badge } from './badge';

const ICONS: Record<StatusIcon, typeof Check> = {
  clock: Clock,
  check: Check,
  alert: TriangleAlert,
  x: X,
  refund: RotateCcw,
};

/** A transfer's status: icon + text label (never colour alone), from the one mapping. */
export function StatusPill({ status, refundStatus }: { status: TransferStatus; refundStatus?: RefundStatus }) {
  const view = transferStatusView({ status, refundStatus });
  const Icon = ICONS[view.icon];
  return (
    <Badge tone={view.tone}>
      <Icon aria-hidden="true" className="size-3.5" />
      {t(view.labelKey)}
    </Badge>
  );
}
