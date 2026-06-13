'use client';

import { Button } from '@/components/ui/button';

/**
 * Admin "Issue refund" trigger with a browser confirm gate. Issuing a refund —
 * especially on a DELIVERED transfer (a clawback) — moves money, so the one-click
 * server-action form is wrapped in a confirmation. The action itself
 * (issueRefundAction → issueRefund) re-validates eligibility server-side; this is
 * purely a mis-click guard.
 */
export function RefundConfirmButton({
  action,
  transferId,
  confirmText,
}: {
  action: (formData: FormData) => void | Promise<void>;
  transferId: string;
  confirmText: string;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(confirmText)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={transferId} />
      <Button type="submit" size="sm" variant="destructive">
        Issue refund
      </Button>
    </form>
  );
}
