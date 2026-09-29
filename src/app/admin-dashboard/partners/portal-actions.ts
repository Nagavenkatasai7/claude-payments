'use server';

// UI redesign M2-14 Task 14.1 (owner O6): the one-off platform-admin controls that
// record a partner's approved WhatsApp AUTHENTICATION template and switch its
// customer portal on. Platform governance only: a partner admin cannot switch
// its own portal on. The M3 go-live checklist may replace this card later.
//
// Server actions are public POST endpoints (CLAUDE.md), so each one: refuses on
// a partner-site host FIRST (site-host-guard), gates on requirePlatformAdmin()
// BEFORE any read, then lets the repo writer check the partner exists and
// validate, audit and write in one transaction (portal-settings-repo.ts). The
// form's `id` is the page's route param; a platform admin's scope is every
// tenant, so the existence check is the whole target check.
import { revalidatePath } from 'next/cache';
import { requirePlatformAdmin } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { getDb } from '@/db/client';
import { setPortalAuthTemplate, setPortalEnabled } from '@/db/repos/portal-settings-repo';

const partnerIdOf = (formData: FormData): string => String(formData.get('id') ?? '').trim();

export async function recordPortalAuthTemplateAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const id = partnerIdOf(formData);
  const res = await setPortalAuthTemplate(
    getDb(),
    id,
    { name: String(formData.get('name') ?? '').trim(), lang: String(formData.get('lang') ?? '').trim() },
    staff.username,
  );
  if (!res.ok) {
    throw new Error(
      res.reason === 'not_found'
        ? 'Partner not found.'
        : 'Enter the template name exactly as approved in WhatsApp Manager (lowercase letters, digits, underscores) and a language code such as en or en_US.',
    );
  }
  revalidatePath(`/admin-dashboard/partners/${id}`);
}

export async function enablePartnerPortalAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const id = partnerIdOf(formData);
  const res = await setPortalEnabled(getDb(), id, true, staff.username);
  if (!res.ok) {
    throw new Error(
      res.reason === 'not_found'
        ? 'Partner not found.'
        : 'Not ready: record the approved authentication template and connect the partner’s own WhatsApp number first.',
    );
  }
  revalidatePath(`/admin-dashboard/partners/${id}`);
}
