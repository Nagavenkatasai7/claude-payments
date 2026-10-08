'use server';

import { redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import {
  addReferralCode,
  createReferralPartner,
  ReferralAdminError,
  setReferralCodeActive,
  setReferralPlumUrl,
  updateReferralPartner,
} from '@/lib/referral-admin';

// /admin-dashboard/referrals (Batch B4). Each export is a PUBLIC POST endpoint: it refuses a
// partner subdomain, then requirePlatformAdmin(), then hands the RAW form fields to the
// referral-admin service, which re-checks the actor, validates every field, checks that the id or
// code exists, and writes the change and its audit row in one transaction. Errors come back as a
// fixed code (the page shows allowlisted text only).

const PAGE = '/admin-dashboard/referrals';

async function run(op: () => Promise<unknown>, ok: string): Promise<never> {
  let error: string | null = null;
  try {
    await op();
  } catch (e) {
    if (!(e instanceof ReferralAdminError)) throw e;
    error = e.code;
  }
  // redirect() throws, so it stays outside the try.
  redirect(error === null ? `${PAGE}?ok=${ok}` : `${PAGE}?error=${error}`);
}

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v : '';
};

export async function createReferralPartnerAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  await run(
    () =>
      createReferralPartner(
        staff,
        { name: str(formData, 'name'), contact: str(formData, 'contact'), commissionUsd: str(formData, 'commission') },
        getDb(),
      ),
    'created',
  );
}

export async function updateReferralPartnerAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  await run(
    () =>
      updateReferralPartner(
        staff,
        str(formData, 'id'),
        {
          name: str(formData, 'name'),
          contact: str(formData, 'contact'),
          commissionUsd: str(formData, 'commission'),
          status: str(formData, 'status'),
        },
        getDb(),
      ),
    'updated',
  );
}

export async function addReferralCodeAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  await run(() => addReferralCode(staff, str(formData, 'id'), str(formData, 'code'), getDb()), 'code');
}

export async function setReferralCodeActiveAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  await run(() => setReferralCodeActive(staff, str(formData, 'code'), str(formData, 'enabled'), getDb()), 'code');
}

export async function setReferralPlumUrlAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  await run(() => setReferralPlumUrl(staff, str(formData, 'url'), getDb()), 'settings');
}
