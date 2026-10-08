'use client';

import { useActionState } from 'react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ds';
import type { ActionResult } from '../../action-result';
import { cancelLinkAction } from './actions';

async function submit(_prev: ActionResult | null, formData: FormData): Promise<ActionResult | null> {
  return cancelLinkAction(formData);
}

/** Cancel one open link. The action re-reads the link under the session's tenant and refuses anything not open. */
export function CancelLinkButton({ linkId }: { linkId: string }) {
  const [state, formAction, pending] = useActionState(submit, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={linkId} />
      <Button type="submit" size="sm" variant="danger" disabled={pending}>
        {t('partner.paymentLinks.cancel')}
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="mt-1 text-[12.5px] font-semibold text-ds-danger-ink">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
