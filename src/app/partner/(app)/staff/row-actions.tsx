'use client';

import { useState } from 'react';
import { t } from '@/lib/i18n';
import { Button, ConfirmDialog } from '@/components/ds';
import type { ActionResult } from '../../action-result';
import { removeStaffAction, revokeInviteAction } from './actions';

// Per-row controls for /partner/staff (UI redesign M3-8). ConfirmDialog's form cannot carry hidden
// inputs, so the target (a username, an invite id) is set on the FormData here. It is attacker-
// controlled like any form field: the server action re-gates and resolves it inside the session
// tenant (a foreign or missing target is the same "not found").

function Outcome({ state }: { state: ActionResult | null }) {
  return (
    <span aria-live="polite">
      {state && state.ok === false ? (
        <span role="alert" className="block text-[13px] font-semibold text-ds-danger-ink">
          {state.error}
        </span>
      ) : null}
    </span>
  );
}

export function RemoveMember({ username, name }: { username: string; name: string }) {
  const [state, setState] = useState<ActionResult | null>(null);
  return (
    <div className="flex flex-col items-start gap-1">
      <ConfirmDialog
        trigger={
          <Button type="button" variant="ghost" size="sm" aria-label={t('partner.staff.removeName', { name })}>
            {t('partner.staff.remove')}
          </Button>
        }
        title={t('partner.staff.removeTitle', { name })}
        body={<p>{t('partner.staff.removeBody')}</p>}
        confirmLabel={t('partner.staff.removeConfirm')}
        destructive
        requireReason={false}
        action={async (fd) => {
          fd.set('username', username);
          setState(await removeStaffAction(fd));
        }}
      />
      <Outcome state={state} />
    </div>
  );
}

export function RevokeInvite({ id, username }: { id: string; username: string }) {
  const [state, setState] = useState<ActionResult | null>(null);
  return (
    <div className="flex flex-col items-start gap-1">
      <ConfirmDialog
        trigger={
          <Button type="button" variant="ghost" size="sm" aria-label={t('partner.staff.revokeName', { name: username })}>
            {t('partner.staff.revoke')}
          </Button>
        }
        title={t('partner.staff.revokeName', { name: username })}
        body={<p>{t('partner.staff.revokeBody')}</p>}
        confirmLabel={t('partner.staff.revoke')}
        destructive
        requireReason={false}
        action={async (fd) => {
          fd.set('id', id);
          setState(await revokeInviteAction(fd));
        }}
      />
      <Outcome state={state} />
    </div>
  );
}
