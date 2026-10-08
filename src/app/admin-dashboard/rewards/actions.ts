'use server';

import { revalidatePath } from 'next/cache';
import { requirePlatformAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { getPartnerStore } from '@/lib/partner-store';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { logWarn } from '@/lib/log';
import { saveCatalogEntry, saveTerms } from '@/lib/rewards/admin';
import { parseCatalogForm, parseTermsForm } from '@/lib/rewards/settings';
import { isFundedRewardKind } from '@/lib/rewards/types';

// /admin-dashboard/rewards (B3 rewards v1) — the platform admin's two writers. Public POST
// endpoints: each one refuses a partner-site host, self-gates (requirePlatformAdmin: platform
// ADMIN only), validates every field (rewards/settings.ts) and, for the terms, checks that the
// named partner exists, before the writer saves the row and ONE audit row in one transaction.
// Errors are fixed copy, rendered as text by the form (never put in a URL).

export type RewardsAdminResult = { ok: true } | { ok: false; error: string };

const PAGE = '/admin-dashboard/rewards';
const FAILED: RewardsAdminResult = { ok: false, error: 'Not saved. Please try again.' };

export async function saveCatalogAction(_prev: RewardsAdminResult | null, formData: FormData): Promise<RewardsAdminResult> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const kind = formData.get('kind');
  if (!isFundedRewardKind(kind)) return { ok: false, error: 'Choose a reward.' };
  const parsed = parseCatalogForm(kind, formData);
  if (!parsed.ok) return parsed;
  try {
    await saveCatalogEntry(getDb(), { username: staff.username }, parsed.value);
  } catch (err) {
    logWarn('admin.rewards.catalog', err instanceof Error ? err.name : 'error', { kind });
    return FAILED;
  }
  revalidatePath(PAGE);
  return { ok: true };
}

export async function saveTermsAction(_prev: RewardsAdminResult | null, formData: FormData): Promise<RewardsAdminResult> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const raw = formData.get('partnerId');
  const partnerId = typeof raw === 'string' ? raw.trim() : '';
  if (partnerId === '' || partnerId.length > 100) return { ok: false, error: 'Choose an existing partner.' };
  const parsed = parseTermsForm(formData);
  if (!parsed.ok) return parsed;
  try {
    if ((await getPartnerStore().getPartner(partnerId)) === null) return { ok: false, error: 'Choose an existing partner.' };
    await saveTerms(getDb(), { username: staff.username }, partnerId, parsed.value);
  } catch (err) {
    logWarn('admin.rewards.terms', err instanceof Error ? err.name : 'error', { partnerId });
    return FAILED;
  }
  revalidatePath(PAGE);
  return { ok: true };
}
