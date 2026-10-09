'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getPartnerStore } from '@/lib/partner-store';
import { applyFlagChange, FlagChangeError } from '@/lib/flag-switch';
import { pokeWorker } from '@/lib/outbox';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { connectTelegramWebhook } from '@/lib/telegram';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { logWarn } from '@/lib/log';

// /admin-dashboard/switches — the ONE server action that writes a switch. A
// public POST endpoint: it self-gates (requirePlatformAdmin) and passes the raw
// form fields to applyFlagChange, which validates every field again and writes
// the flag, the audit row and the ops alert in one transaction.

const PAGE = '/admin-dashboard/switches';

/** `scope` is "<type>:<id>" (global: "global:"). Split on the FIRST colon only. */
function splitScope(raw: FormDataEntryValue | null): { scopeType: string; scopeId: string } {
  const s = typeof raw === 'string' ? raw : '';
  const i = s.indexOf(':');
  return i < 0 ? { scopeType: s, scopeId: '' } : { scopeType: s.slice(0, i), scopeId: s.slice(i + 1) };
}

export async function changeFlagAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const { scopeType, scopeId } = splitScope(formData.get('scope'));
  let error: string | null = null;
  try {
    await applyFlagChange(
      staff,
      {
        key: formData.get('key'),
        scopeType,
        scopeId,
        enabled: formData.get('enabled'),
        reason: formData.get('reason'),
      },
      { db: getDb(), partnerExists: async (id) => (await getPartnerStore().getPartner(id)) !== null },
    );
  } catch (e) {
    if (!(e instanceof FlagChangeError)) throw e;
    error = e.message; // fixed text; the page shows it only when it is on the allowlist
  }
  if (error === null) {
    pokeWorker(); // send the ops alert now, not at the next cron tick
    revalidatePath('/admin-dashboard', 'layout'); // the red banner on every admin page
  }
  // redirect() throws, so it stays outside the try.
  redirect(error === null ? `${PAGE}?ok=1` : `${PAGE}?error=${encodeURIComponent(error)}`);
}

/**
 * Telegram test channel: register this deployment's webhook with Telegram
 * (setWebhook with TELEGRAM_WEBHOOK_SECRET). Platform admin only; one audit row
 * either way (never the token or the secret).
 */
export async function connectTelegramWebhookAction(): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const outcome = await connectTelegramWebhook();
  if (outcome.result === 'error') logWarn('telegram.webhook', outcome.cause);
  const code = outcome.result === 'error' ? outcome.code : undefined;
  await createAuditRepo(getDb()).record({
    actor: staff.username,
    actorType: 'staff',
    action: 'telegram.webhook_set',
    meta: { result: outcome.result, ...(code !== undefined ? { code } : {}) },
  });
  redirect(`${PAGE}?telegram=${outcome.result}${code !== undefined ? `&code=${code}` : ''}`);
}
