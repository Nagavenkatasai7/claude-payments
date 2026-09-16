import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { verifyMetaSignature } from '@/lib/providers/meta-signature-verify';
import { parsePhoneNumberId } from '@/lib/whatsapp';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { getPartnerIntegrationsStore, partnerForPhoneNumberId } from '@/lib/partner-integrations-store';
import { processInboundWebhook } from '@/lib/whatsapp-inbound';

// The SHARED Meta webhook. The default/SmartRemit number lives here; partner-
// owned numbers may also land here (their Meta app pointed at the shared URL) —
// they are routed by metadata.phone_number_id through the pnid→partner index and
// verified with THAT partner's app secret. Partners can instead use their
// dedicated /api/whatsapp/[partnerId] endpoint (strict, fail-closed).

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode === 'subscribe' && token === env.whatsappVerifyToken && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse('Forbidden', { status: 403 });
}

export async function POST(req: NextRequest) {
  const raw = await req.text(); // raw bytes first — Meta signs the exact body

  // Parse early ONLY to discover which number (and thus which partner + app
  // secret) this event belongs to. Nothing acts on the body until the signature
  // gate below passes — JSON.parse + two Redis reads are side-effect-free.
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }

  // WL2 routing: the receiving number's phone_number_id → owning partner.
  const pnid = parsePhoneNumberId(body);
  const routedPartnerId = pnid
    ? await partnerForPhoneNumberId(pnid)
    : null;
  const integrations = routedPartnerId
    ? await getPartnerIntegrationsStore().getIntegrations(routedPartnerId)
    : null;

  // Signature gate, ABOVE markMessageSeen, so a forged body can't touch the
  // dedup set or any downstream processing.
  //   routed (a partner's BYO number)  ⇒ THAT partner's app secret, and ONLY
  //     that — no platform fallback. A routed partner with no app secret is
  //     401: after fix 1 routing IS tenant identity, so an event that cannot be
  //     verified as that partner's must never be processed as that partner's.
  //     (Variant A: a routed partner MUST configure its own Meta app secret; a
  //     BYO number that lives under the PLATFORM Meta app is supported only by
  //     variant B below, which is not this code. Pre-apply query (c) in Step
  //     2.2 is what decides which variant ships.)
  //   unrouted (the shared number)     ⇒ the platform META_APP_SECRET; warn-and-
  //     proceed only when none is configured (dev/test — unchanged legacy).
  const signature = req.headers.get('x-hub-signature-256') ?? '';
  if (routedPartnerId) {
    const partnerSecret = integrations?.whatsapp.appSecret ?? '';
    if (!partnerSecret || !verifyMetaSignature(raw, signature, partnerSecret)) {
      return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
    }
  } else if (env.metaAppSecret === '') {
    console.warn('META_APP_SECRET unset — skipping X-Hub-Signature-256 verification');
  } else if (!verifyMetaSignature(raw, signature, env.metaAppSecret)) {
    return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
  }

  const result = await processInboundWebhook(body, {
    routedPartnerId,
    waCreds: waCredsFrom(integrations),
  });
  return NextResponse.json(result);
}
