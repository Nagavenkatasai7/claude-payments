import { NextRequest, NextResponse } from 'next/server';
import { verifyMetaSignature } from '@/lib/providers/meta-signature-verify';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { getPartnerStore } from '@/lib/partner-store';
import { getPartnerIntegrationsStore } from '@/lib/partner-integrations-store';
import { processInboundWebhook } from '@/lib/whatsapp-inbound';

// WL2: a partner's DEDICATED Meta webhook — the URL they paste into their own
// Meta app's webhook configuration. Solves the GET-verification problem (Meta's
// hub.challenge carries NO phone_number_id, so a shared endpoint can never know
// whose verify token to check): here the partner is named in the URL.
//
// STRICT, fail-closed: the partner must exist, be active, and have BOTH their
// verifyToken (GET) and appSecret (POST) configured — no env fallback on this
// endpoint. The shared /api/whatsapp keeps the legacy/default behavior.

async function loadPartner(partnerId: string) {
  const partner = await getPartnerStore().getPartner(partnerId);
  if (!partner || partner.status !== 'active') return null;
  const integrations = await getPartnerIntegrationsStore().getIntegrations(partnerId);
  return { partner, integrations };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ partnerId: string }> },
) {
  const { partnerId } = await params;
  const loaded = await loadPartner(partnerId);
  // Generic 403s — never disclose whether a partner id exists.
  if (!loaded || !loaded.integrations.whatsapp.verifyToken) {
    return new NextResponse('Forbidden', { status: 403 });
  }
  const p = req.nextUrl.searchParams;
  if (
    p.get('hub.mode') === 'subscribe' &&
    p.get('hub.verify_token') === loaded.integrations.whatsapp.verifyToken &&
    p.get('hub.challenge')
  ) {
    return new NextResponse(p.get('hub.challenge'), { status: 200 });
  }
  return new NextResponse('Forbidden', { status: 403 });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ partnerId: string }> },
) {
  const { partnerId } = await params;
  const raw = await req.text(); // raw bytes first — Meta signs the exact body

  const loaded = await loadPartner(partnerId);
  const appSecret = loaded?.integrations.whatsapp.appSecret ?? '';
  // Fail-closed always: unknown partner, suspended partner, or unconfigured
  // app secret all reject. This endpoint never runs unverified traffic.
  if (!loaded || appSecret === '') {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const signature = req.headers.get('x-hub-signature-256') ?? '';
  if (!verifyMetaSignature(raw, signature, appSecret)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }

  const result = await processInboundWebhook(body, {
    routedPartnerId: partnerId,
    waCreds: waCredsFrom(loaded.integrations),
  });
  return NextResponse.json(result);
}
