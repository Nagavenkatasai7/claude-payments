'use client';

import { Button } from '@/components/ui/button';

/**
 * Staff "Cancel" trigger for a recurring schedule with a browser confirm gate
 * (Program-Fix 36). Cancelled is terminal — the customer would have to set the
 * schedule up again — so the one-click server-action form is wrapped in a
 * confirmation. The action itself (cancelScheduleAction) re-gates permission,
 * scope and the transition server-side; this is purely a mis-click guard.
 */
export function CancelScheduleButton({
  action,
  scheduleId,
  confirmText,
}: {
  action: (formData: FormData) => void | Promise<void>;
  scheduleId: string;
  confirmText: string;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(confirmText)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={scheduleId} />
      <Button type="submit" size="sm" variant="outline" className="text-destructive">
        Cancel
      </Button>
    </form>
  );
}
