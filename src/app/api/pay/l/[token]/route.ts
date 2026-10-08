import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { getDb } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getPortalSettings, portalAuthTemplate } from '@/db/repos/portal-settings-repo';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { logError, logWarn } from '@/lib/log';
import { isInfraError } from '@/lib/infra-error';
import { disclosureProviderKind, isDisclosureAckVersion } from '@/lib/remittance-disclosure';
import { resolvePartnerDisclosure } from '@/lib/partner-config';
import { resolveDirectOtpChannel } from '@/lib/direct-otp-channel';
import { recordChannelHealth } from '@/lib/channel-health';
import { isInServiceWindow } from '@/lib/whatsapp-errors';
import { getTransactionOtpStore } from '@/lib/transaction-otp';
import { sendTransactionOtp } from '@/lib/whatsapp';
import { SENDS_PAUSED_MESSAGE } from '@/lib/flags';
import { FX_UNAVAILABLE_MESSAGE } from '@/lib/rate';
import { pokeWorker } from '@/lib/outbox';
import { processTransferPayment } from '@/lib/pay-process';
import { finalizeLinkPayment, resolvePayableLink } from '@/lib/payment-link-finalize';
import { getLinkQuoteStore } from '@/lib/payment-link-quote';
import { isLinkFundingMethod, LINK_INACTIVE_MESSAGE } from '@/lib/payment-links';
import type { PartnerId } from '@/lib/types';

// Batch B2: the customer's payment of a payment link (/pay/l/[token]).
//
//   {action:'request_otp'}                → a WhatsApp code to the link's phone
//   {otp, fundingMethod, disclosureVersion} → verify, mint ONE transfer
//                                            (finalizeLinkPayment, claim-first),
//                                            then the SAME capture + settle-or-hold
//                                            as the hosted pay page (pay-process.ts)
//
// The token in the path is the only input that picks the link; the amount, the
// payee, the phone, the purpose and the reference all come from the link row.
// Every unpayable state (unknown token, switch off, not a demo phone, payee not
// approved, cancelled, expired, already paid) answers the SAME 404 and sends
// nothing. Mock/test funding only: capture goes through the existing funding
// provider exactly like /api/pay/[transferId].

export const maxDuration = 300;

const inactive = () => NextResponse.json({ ok: false, error: LINK_INACTIVE_MESSAGE }, { status: 404 });
const otpSendFailed = () => NextResponse.json({ ok: false, reason: 'otp_send_failed' }, { status: 502 });

/** The code's per-transaction key: bound to the LINK, never to a transfer id. */
const otpKey = (linkId: string) => `paylink:${linkId}`;

async function recordDisclosureAck(partnerId: PartnerId, transferId: string, version: string): Promise<void> {
  try {
    const providerKind = disclosureProviderKind(resolvePartnerDisclosure(await getPartnerStore().getPartner(partnerId)));
    await createAuditRepo(getDb()).record({
      partnerId,
      actor: 'pay-link',
      actorType: 'system',
      action: 'remittance.disclosure_ack',
      subjectId: transferId,
      meta: { version, providerKind },
    });
  } catch (err) {
    logWarn('paylink.disclosure_ack', err, { transferId });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Per-IP ceiling over the whole route (codes + pay attempts). Fail-open by design.
  const limited = await enforceIpRateLimit(req, 'pay', 30);
  if (limited) return limited;

  try {
    let body: { action?: unknown; otp?: unknown; fundingMethod?: unknown; disclosureVersion?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }

    const store = getStore();
    const db = getDb();
    const payable = await resolvePayableLink(db, store, token);
    if (!payable) return inactive();
    const { link } = payable;
    const phone = link.customerPhone;
    const otpStore = getTransactionOtpStore();

    // ── (1) A WhatsApp code to the link's phone. Nothing is minted or charged. ──
    if (body.action === 'request_otp') {
      // The sending number is resolved BEFORE a code is minted and fails closed
      // (direct-otp-channel.ts): a refusal spends no issue budget.
      const channel = await resolveDirectOtpChannel(link.partnerId, 'paylink.otp-channel');
      if (!channel.ok) return otpSendFailed();
      // On the partner's own number, its approved authentication template carries
      // the code (a link customer has often never messaged that number); without
      // one, a free-form text arrives only inside the 24-h window.
      let template: { name: string; lang: string } | undefined;
      if (channel.creds) {
        try {
          template = portalAuthTemplate(await getPortalSettings(db, link.partnerId));
        } catch (err) {
          logWarn('paylink.otp-template-lookup', err instanceof Error ? err.name : 'error', { partnerId: link.partnerId });
        }
        if (!template && !(await isInServiceWindow(store, link.partnerId, phone))) return otpSendFailed();
      }
      const issued = await otpStore.issue(otpKey(link.id), phone, { kind: 'pay', partnerId: link.partnerId });
      if (!issued.ok && issued.reason === 'locked') {
        return NextResponse.json({ ok: false, reason: 'locked' }, { status: 429 });
      }
      if (issued.ok) {
        const tenant = link.partnerId;
        try {
          // No brand argument: the code's wording names SmartRemit (owner branding decision).
          await sendTransactionOtp(phone, issued.code, channel.creds, undefined, template, {
            inWindow: () => isInServiceWindow(store, tenant, phone),
            onTemplateFailure: async ({ status, code }) => {
              if (status === undefined || status < 400 || status >= 500) return;
              if (await recordChannelHealth(tenant, 'auth_template_failed', code !== undefined ? { code } : {})) pokeWorker();
            },
          });
        } catch {
          // Honest: the code never arrived. Shorten the cooldown so Resend works soon. Never log the code.
          try {
            await otpStore.shortenCooldown(otpKey(link.id));
          } catch {
            /* the 30-s cooldown simply runs out */
          }
          return otpSendFailed();
        }
      }
      return NextResponse.json({ ok: true, sent: true });
    }

    // ── (2) Pay. Recoverable refusals come BEFORE the code is verified, so they never burn it. ──
    const fundingMethod = body.fundingMethod;
    if (!isLinkFundingMethod(fundingMethod)) {
      return NextResponse.json({ ok: false, error: 'Choose how you want to pay.' }, { status: 400 });
    }
    // What-you-see-is-what-you-pay: the rate the page locked, never a re-quote.
    const rate = await getLinkQuoteStore().get(link.id);
    if (!rate && !payable.transfer) {
      return NextResponse.json(
        { ok: false, reason: 'quote_expired', error: 'The rate updated. Please review the new total.' },
        { status: 409 },
      );
    }

    const otpCode = String(body.otp ?? '').replace(/\D/g, '');
    const otpCheck = await otpStore.verify(otpKey(link.id), phone, otpCode);
    if (!otpCheck.ok) {
      return NextResponse.json(
        { ok: false, error: 'Enter the confirmation code we sent to your WhatsApp.', reason: 'otp' },
        { status: 403 },
      );
    }

    const minted = await finalizeLinkPayment(
      {
        store,
        customerStore: getCustomerStore(store),
        partnerStore: getPartnerStore(),
        monthlyVolumeStore: getMonthlyVolumeStore(),
        dailyVolumeStore: getDailyVolumeStore(),
        db,
      },
      // A resume (transfer already minted) never reads the rate; the lock may have lapsed by then.
      { token, fundingMethod, rate },
    );
    if (!minted.ok) {
      switch (minted.error) {
        case 'inactive':
          return inactive();
        case 'kyc_required':
          return NextResponse.json(
            { ok: false, error: 'Please verify your identity before paying.', kyc_required: true },
            { status: 403 },
          );
        case 'sends_paused':
          return NextResponse.json({ ok: false, reason: 'sends_paused', error: SENDS_PAUSED_MESSAGE }, { status: 503 });
        case 'busy':
          return NextResponse.json({ ok: false, reason: 'busy', error: 'Please try again.' }, { status: 503 });
        case 'fx_unavailable':
          return NextResponse.json({ ok: false, reason: 'fx_unavailable', error: FX_UNAVAILABLE_MESSAGE }, { status: 503 });
        case 'quote_error':
          return NextResponse.json(
            { ok: false, reason: 'quote_error', error: 'This amount cannot be paid online. Please contact the company.' },
            { status: 400 },
          );
        case 'cap':
          return NextResponse.json(
            { ok: false, reason: 'cap', error: 'This payment exceeds your current sending limit.' },
            { status: 400 },
          );
        case 'blocked':
        case 'payee_unavailable':
          // One generic answer: never which check refused (no compliance leak).
          return NextResponse.json({ ok: false, error: "We can't process this payment." }, { status: 400 });
      }
    }

    if (isDisclosureAckVersion(body.disclosureVersion)) {
      await recordDisclosureAck(link.partnerId, minted.transferId, body.disclosureVersion);
    }

    const transfer = await store.getTransfer(minted.transferId);
    if (!transfer || transfer.partnerId !== link.partnerId) {
      return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
    }
    const res = await processTransferPayment(store, transfer);
    // The receipt needs the transfer id; the page reads it from here.
    const out = (await res.clone().json()) as Record<string, unknown>;
    return NextResponse.json({ ...out, transferId: transfer.id }, { status: res.status });
  } catch (err) {
    logError('paylink.route', err, {});
    if (isInfraError(err)) {
      return NextResponse.json(
        { ok: false, error: 'Temporary problem. Please try again in a moment.', reason: 'temporarily_unavailable' },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
  }
}
