'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { createPartnerApplicationRepo, createPartnerRequestRepo } from '@/db/repos/aux-repos';
import { newTransferId } from '@/lib/id';
import { checkIpRateLimit, clientIpFrom } from '@/lib/ip-rate-limit';
import { hashApplicationToken, isApplicationTokenExpired } from '@/lib/partner-application-token';
import { getRedis } from '@/lib/redis';
import { getStore } from '@/lib/store';
import type {
  PartnerApplicationDetails,
  PartnerApplicationDocument,
} from '@/lib/types';

// submitPartnerApplicationAction — the PUBLIC, token-gated detailed-application
// submit. The URL token (hidden field) is the only identity: re-hash it, resolve
// the partner_request, and refuse a missing/expired/completed link — NEVER trust
// the body for who this is. A per-IP fixed-window limit caps abuse (fail-open).
// On success we persist the application AND flip the request to 'completed' (the
// single-use kill switch) in ONE transaction, then redirect back to the page —
// which now renders the thank-you state.

// Every §1–§4 detail field, with a per-field max length (partner business data,
// stored verbatim — not customer PII). Order mirrors PartnerApplicationDetails.
const DETAIL_FIELDS: { name: keyof PartnerApplicationDetails; max: number }[] = [
  // §1 Company & legal entity
  { name: 'legalName', max: 200 },
  { name: 'tradingName', max: 200 },
  { name: 'registrationNumber', max: 100 },
  { name: 'countryOfIncorporation', max: 100 },
  { name: 'registeredAddress', max: 500 },
  { name: 'website', max: 300 },
  { name: 'yearEstablished', max: 20 },
  { name: 'ownership', max: 2000 },
  // §2 Licensing, regulation & compliance
  { name: 'isLicensed', max: 20 },
  { name: 'licenseTypes', max: 1000 },
  { name: 'primaryRegulator', max: 300 },
  { name: 'otherJurisdictions', max: 1000 },
  { name: 'amlProgram', max: 4000 },
  { name: 'complianceOfficerName', max: 200 },
  { name: 'complianceOfficerEmail', max: 320 },
  { name: 'sanctionsApproach', max: 4000 },
  { name: 'lastAuditDate', max: 50 },
  // §3 Operations & settlement
  { name: 'corridors', max: 1000 },
  { name: 'expectedMonthlyVolumeUsd', max: 100 },
  { name: 'avgTransferSize', max: 100 },
  { name: 'currentMonthlyVolume', max: 100 },
  { name: 'settlementBank', max: 300 },
  { name: 'settlementCountry', max: 100 },
  { name: 'settlementCurrencies', max: 200 },
  { name: 'payoutMethods', max: 500 },
  // §4 Technical & contacts
  { name: 'integrationPreference', max: 100 },
  { name: 'whatsappNumber', max: 40 },
  { name: 'brandName', max: 200 },
  { name: 'primaryContact', max: 300 },
  { name: 'complianceContact', max: 300 },
  { name: 'technicalContact', max: 300 },
  { name: 'notes', max: 4000 },
];

// The minimum we require to consider an application submittable.
const REQUIRED: (keyof PartnerApplicationDetails)[] = [
  'legalName',
  'countryOfIncorporation',
  'primaryContact',
];

const MAX_DOCS = 4;

/**
 * True only when `url` is an https URL whose HOSTNAME is the Vercel Blob host
 * (….public.blob.vercel-storage.com). A substring check would pass attacker URLs
 * like `https://evil.com/?x=blob.vercel-storage.com`, `https://blob.vercel-
 * storage.com.evil.com/…`, or `https://blob.vercel-storage.com@evil.com/…` — so
 * we PARSE the URL and anchor on the hostname suffix instead.
 */
function isBlobUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)public\.blob\.vercel-storage\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Parse the hidden `documents` JSON into a clean, bounded ref list (never trust shape). */
function parseDocuments(raw: string): PartnerApplicationDocument[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PartnerApplicationDocument[] = [];
  for (const item of parsed.slice(0, MAX_DOCS)) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    const url = typeof d.url === 'string' ? d.url : '';
    // Only accept refs that point at our Blob store (the upload route's output).
    if (!isBlobUrl(url)) continue;
    out.push({
      label: typeof d.label === 'string' ? d.label.slice(0, 100) : 'Document',
      url,
      size: typeof d.size === 'number' && Number.isFinite(d.size) ? d.size : 0,
      contentType: typeof d.contentType === 'string' ? d.contentType.slice(0, 100) : '',
    });
  }
  return out;
}

export async function submitPartnerApplicationAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '').trim();
  const back = `/partners/apply/${encodeURIComponent(token)}`;

  // ── IDENTITY — the token is the ONLY trusted input. Re-validate server-side. ──
  if (!token) redirect('/');
  const request = await getStore().getPartnerRequestByTokenHash(hashApplicationToken(token));
  if (
    !request ||
    isApplicationTokenExpired(request.tokenExpiresAt) ||
    request.applicationStatus === 'completed'
  ) {
    redirect(back); // the page renders the friendly invalid/thank-you status
  }

  // ── RATE LIMIT — blunt per-IP outer ring; fail-open on any limiter error. ──
  // Shared `clientIpFrom` (x-forwarded-for first hop, x-real-ip fallback) — the
  // same keying the upload route uses, so the two entry points limit consistently.
  const ip = clientIpFrom(await headers());
  let allowed = true;
  try {
    const r = await checkIpRateLimit(getRedis(), 'partner-application', ip, {
      limit: 10,
      windowSec: 3600,
    });
    allowed = r.allowed;
  } catch {
    allowed = true; // availability wins — never block on a limiter outage
  }
  if (!allowed) redirect(`${back}?error=rate`);

  // ── READ + VALIDATE (server-side, authoritative) ──────────────────────────
  const details: PartnerApplicationDetails = {};
  for (const { name, max } of DETAIL_FIELDS) {
    const v = String(formData.get(name) ?? '').trim().slice(0, max);
    if (v) details[name] = v;
  }

  for (const field of REQUIRED) {
    if (!details[field]) redirect(`${back}?error=missing`);
  }

  const documents = parseDocuments(String(formData.get('documents') ?? '[]'));

  // ── PERSIST + single-use FLIP in ONE transaction ─────────────────────────
  // redirect() throws by design — keep it OUT of the transaction so it is never
  // swallowed. A genuine DB failure should surface, not fake success.
  await getDb().transaction(async (tx) => {
    await createPartnerApplicationRepo(tx).saveApplication({
      id: `papp_${newTransferId()}`,
      partnerRequestId: request.id,
      details,
      documents,
      submittedAt: new Date().toISOString(),
    });
    await createPartnerRequestRepo(tx).markApplicationCompleted(request.id);
  });

  redirect(back); // status is now 'completed' → page shows the thank-you card
}
