import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { getDb } from '@/db/client';
import { getPortalSettings, portalAuthTemplate } from '@/db/repos/portal-settings-repo';
import { enforceIpRateLimit } from '@/lib/ip-rate-limit';
import { logError, logWarn } from '@/lib/log';
import { isInfraError } from '@/lib/infra-error';
import { isOtpConsumeFailure } from '@/lib/otp-consume-failure';
import { isDisclosureAckVersion } from '@/lib/remittance-disclosure';
import { resolveDirectOtpChannel } from '@/lib/direct-otp-channel';
import { recordChannelHealth } from '@/lib/channel-health';
import { isInServiceWindow } from '@/lib/whatsapp-errors';
import { getTransactionOtpStore } from '@/lib/transaction-otp';
import { sendTransactionOtp } from '@/lib/whatsapp';
import { SENDS_PAUSED_MESSAGE } from '@/lib/flags';
import { payNotAvailable, payReloadRequired, transferFunded } from '@/lib/pay-not-available';
import { parsePayBody } from '@/lib/pay-body';
import { readPayGateContext } from '@/lib/pay-gate-context';
import { disclosureGateAtRequest, disclosureGateRefusal } from '@/lib/pay-disclosure-gate';
import { payMoneyGateRefusal } from '@/lib/pay-money-gate';
import { buildPaymentAuthEvidence } from '@/lib/payment-auth-evidence';
import { providerLineFor } from '@/lib/legal/provider-line';
import type { PaymentEvidence } from '@/lib/payment-evidence';
import { FX_UNAVAILABLE_MESSAGE } from '@/lib/rate';
import { pokeWorker } from '@/lib/outbox';
import { processTransferPayment } from '@/lib/pay-process';
import { finalizeLinkPayment, resolvePayableLink } from '@/lib/payment-link-finalize';
import { getLinkQuoteStore } from '@/lib/payment-link-quote';
import { isLinkFundingMethod, LINK_INACTIVE_MESSAGE, type LinkFundingMethod } from '@/lib/payment-links';

// Batch B2: the customer's payment of a payment link (/pay/l/[token]).
//
//   {action:'request_otp'}                → a WhatsApp code to the link's phone
//   {otp, fundingMethod, disclosureVersion, disclosureHash, quoteLockedAt}
//                                         → verify, mint ONE transfer
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

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Per-IP ceiling over the whole route (codes + pay attempts). Fail-open by design.
  const limited = await enforceIpRateLimit(req, 'pay', 30);
  if (limited) return limited;

  try {
    // Fix pack 4 (C13): the one pay-body parser. A JSON error reads as {}.
    // quoteLockedAt is the identity of the rate lock the page showed.
    let raw: unknown = {};
    try {
      raw = await req.json();
    } catch {
      raw = {};
    }
    const body = parsePayBody(raw, 'link');

    const store = getStore();
    const db = getDb();
    const payable = await resolvePayableLink(db, store, token);
    if (!payable) return inactive();
    const { link } = payable;
    const phone = link.customerPhone;
    const otpStore = getTransactionOtpStore();
    // Fix pack 4 (C12 link route): the R18 gate context, read once. The link's
    // partner is both the owner and the rail; a resume carries the minted row's
    // environment, a fresh link mints live. Never throws (the SAFE context).
    const ctx = await readPayGateContext(db, {
      ownerId: link.partnerId,
      railPartnerId: link.partnerId,
      environment: payable.transfer?.environment,
      transferType: 'b2c',
    });
    // Fix pack 5 T13b (P13 route pre-verify, M5): pay-process steps 5 (no
    // unsigned rail) and 7 (no mock funding on real money) answered BEFORE a
    // code is issued or checked, so their 409 never spends the code and nothing
    // is minted first. Only a known real-money rail makes a read; pay-process
    // stays the backstop. A link not minted yet is judged on the b2c fields it
    // mints with (both link funding methods are customer-paid, never pulled).
    const moneyGateRefused = async (fundingMethod: LinkFundingMethod): Promise<boolean> => {
      const subject = payable.transfer ?? {
        transferType: 'b2c' as const,
        fundingMethod,
        partnerId: link.partnerId,
        settlementPartnerId: undefined,
        environment: undefined,
        fundingProvider: undefined,
        fundingIntentRef: undefined,
      };
      const code = await payMoneyGateRefusal(db, { ctx, railPartnerId: link.partnerId, subject });
      if (!code) return false;
      logWarn('pay.preverify-refused', 'money gate', { linkId: link.id, code });
      return true;
    };

    // ── (1) A WhatsApp code to the link's phone. Nothing is minted or charged. ──
    if (body.action === 'request_otp') {
      // The sending number is resolved BEFORE a code is minted and fails closed
      // (direct-otp-channel.ts): a refusal spends no issue budget.
      const channel = await resolveDirectOtpChannel(link.partnerId, 'paylink.otp-channel');
      if (!channel.ok) return otpSendFailed();
      // Fix pack 4 (C10 c): a mandatory payment (certified owner, or a real-money
      // rail) whose provider block is not approved gets no code at all.
      if (disclosureGateAtRequest({ mandatory: ctx.mandatory, disclosure: ctx.disclosure })) return payNotAvailable();
      if (await moneyGateRefused('bank_transfer')) return payNotAvailable();
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
        // Fix pack 4 (C22 c, R16): the link owner's approved provider line, from
        // the gate context (no extra partner read); no key when there is none.
        const providerLine = providerLineFor(ctx.disclosure) ?? undefined;
        let sentOn: 'wa' | 'tg' | undefined;
        try {
          // No brand argument: the code's wording names SmartRemit (owner branding decision).
          sentOn = await sendTransactionOtp(phone, issued.code, channel.creds, undefined, template, {
            // Fix pack 4 (C5): a payment code (a Telegram chat gets the transaction text).
            purpose: 'payment',
            ...(providerLine ? { providerLine } : {}),
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
        // Fix pack 4 (C5): which channel carried THIS code (for the otp.verified
        // row). Best-effort: never blocks the code that was sent.
        try {
          await otpStore.noteDelivery(otpKey(link.id), issued.issuedAt, sentOn ?? null);
        } catch { /* never blocks the code */ }
      }
      return NextResponse.json({ ok: true, sent: true });
    }

    // ── (2) Pay. Recoverable refusals come BEFORE the code is verified, so they never burn it. ──
    const fundingMethod = body.fundingMethod;
    if (!isLinkFundingMethod(fundingMethod)) {
      return NextResponse.json({ ok: false, error: 'Choose how you want to pay.' }, { status: 400 });
    }
    // What-you-see-is-what-you-pay: the rate the page locked, never a re-quote.
    // The page posts back the lock it rendered; a lapsed lock, or a newer one a
    // later visit made at another rate, is refused so an old tab never pays
    // figures its disclosure did not show. (A resume pays the minted figures.)
    const rate = await getLinkQuoteStore().get(link.id);
    if (!payable.transfer && (!rate || body.quoteLockedAt !== rate.lockedAt)) {
      return NextResponse.json(
        { ok: false, reason: 'quote_expired', error: 'The rate changed. Check the new amount.' },
        { status: 409 },
      );
    }

    // Fix pack 4 (C10 b): the R18 refusals come BEFORE the code is checked, so
    // an old tab or an unapproved block never spends the code. pay-process's R18
    // gate on the minted row stays the authoritative one.
    const gateRefusal = disclosureGateRefusal({
      mandatory: ctx.mandatory,
      disclosure: ctx.disclosure,
      ackVersion: body.disclosureVersion,
      postedHash: body.disclosureHash,
    });
    // Review R1-P1 A1: a minted link row already funded never hears "nothing was charged".
    if (gateRefusal === 'reload_required') return payReloadRequired(!!payable.transfer && transferFunded(payable.transfer));
    if (gateRefusal === 'not_available') return payNotAvailable();
    if (await moneyGateRefused(fundingMethod)) return payNotAvailable();

    const otpCheck = await otpStore.verify(otpKey(link.id), phone, body.otp);
    if (!otpCheck.ok) {
      return NextResponse.json(
        { ok: false, error: 'Enter the confirmation code we sent to your WhatsApp.', reason: 'otp' },
        { status: 403 },
      );
    }

    // Fix pack 4 (C7, R41): the customer's evidence, built ONCE right after the
    // code passed; pay-process commits it on the locked awaiting row BEFORE any
    // charge ("authorise, then capture"). The route id is the LINK id; the rows
    // name the minted transfer. A link payment is always b2c.
    const evidenceAt = Date.now();
    const acked = isDisclosureAckVersion(body.disclosureVersion) ? body.disclosureVersion : null;
    const evidence: PaymentEvidence = {
      auth: buildPaymentAuthEvidence({ otp: otpCheck, headers: req.headers, surface: 'link', routeId: link.id, now: evidenceAt }),
      disclosureAck: acked ? { version: acked, shownHash: body.disclosureHash, routeId: link.id } : null,
      disclosureSnapshot: acked
        ? { surface: 'link', version: acked, shownHash: body.disclosureHash, acknowledgedAt: evidenceAt }
        : null,
    };

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
        case 'not_available':
          // Pack 3 (contract 5): a live control refused the mint; the neutral 409.
          return payNotAvailable();
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

    const transfer = await store.getTransfer(minted.transferId);
    if (!transfer || transfer.partnerId !== link.partnerId) {
      return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
    }
    const res = await processTransferPayment(store, transfer, evidence);
    // The receipt needs the transfer id; the page reads it from here (every
    // status, including the 503 approval_not_recorded).
    const out = (await res.clone().json()) as Record<string, unknown>;
    return NextResponse.json({ ...out, transferId: transfer.id }, { status: res.status });
  } catch (err) {
    // The error NAME only: a query error's message carries its params (the link
    // token, names), and the scrubber masks digits and emails, not those.
    logError('paylink.route', err instanceof Error ? err.name : 'error', {});
    // Review R2-Q1 B4: a failed single-use code consume is retryable whatever its shape.
    if (isInfraError(err) || isOtpConsumeFailure(err)) {
      return NextResponse.json(
        { ok: false, error: 'Temporary problem. Please try again in a moment.', reason: 'temporarily_unavailable' },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
  }
}
