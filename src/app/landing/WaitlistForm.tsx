import { joinWaitlistAction } from '../waitlist-action';
import { WAITLIST_DESTINATIONS } from './corridors';
import { WAITLIST_CONSENT_TEXT, WAITLIST_LIMITS } from '@/lib/waitlist';

// WaitlistForm — the public "Join waitlist" section of the landing page.
// A server component (no client state): the form posts to joinWaitlistAction
// and the page re-renders with ?waitlist=ok|err|rate. Styled in the light
// brand look (off-white surface, navy text, #1e5fd6 buttons) so it reads the
// same before and after the landing re-theme lands. Every input id is
// `wl-`-prefixed: the partner form on the same page already owns `email`,
// `phone` and `website`, and ids must be unique per document.

export interface WaitlistFormProps {
  /** ?waitlist=ok|err|rate from the last submit, if any. */
  status?: string;
  /** utm_source / utm_campaign read from the page URL — carried through hidden inputs. */
  utmSource?: string;
  utmCampaign?: string;
}

const LABEL = 'text-[13px] font-semibold text-[#0b1b3f]';
const INPUT =
  'min-h-[46px] rounded-xl border border-[#8391a8] bg-white px-4 text-[15px] text-[#0b1b3f] placeholder:text-[#667085] focus:border-[#1e5fd6]';
const BTN =
  'mt-1 inline-flex min-h-[50px] items-center justify-center rounded-full bg-[#1e5fd6] px-7 text-[15px] font-bold text-white shadow-[0_10px_26px_-12px_rgba(30,95,214,0.7)] transition-[background-color,transform] duration-150 hover:bg-[#1a52ba] hover:[transform:translateY(-1px)]';

function utmValue(v: string | undefined): string {
  return (v ?? '').slice(0, WAITLIST_LIMITS.utm);
}

export default function WaitlistForm({ status, utmSource, utmCampaign }: WaitlistFormProps) {
  return (
    <section
      id="waitlist"
      className="border-t border-[#dbe4f0] bg-[#f6f8fb] px-5 py-[clamp(64px,9vw,130px)] text-[#0b1b3f]"
      aria-labelledby="waitlist-h"
    >
      <div className="mx-auto grid w-full max-w-[1080px] items-start gap-10 lg:grid-cols-2 lg:gap-20">
        <div>
          <p className="mb-3 text-[13px] font-semibold uppercase tracking-[0.16em] text-[#1e5fd6]">
            Early access
          </p>
          <h2
            id="waitlist-h"
            className="text-[clamp(28px,4vw,46px)] font-semibold leading-[1.1] tracking-[-0.025em]"
          >
            Join the waitlist.
          </h2>
          <p className="mt-4 max-w-[46ch] text-[17px] leading-relaxed text-[#475569]">
            Be first to send money by chatting on WhatsApp. Tell us where you send to and
            we&rsquo;ll message you the moment your corridor opens. No spam — one message when
            it&rsquo;s your turn.
          </p>
        </div>

        <form action={joinWaitlistAction} className="rounded-2xl border border-[#dbe4f0] bg-white p-6 sm:p-8">
          {/* Post-submit notes — driven by ?waitlist=ok|err|rate. */}
          {status === 'ok' && (
            <p
              role="status"
              className="mb-6 rounded-xl border border-[#a7e3c6] bg-[#e8f7ef] px-4 py-3 text-[14px] text-[#065f46]"
            >
              You&rsquo;re on the list — we&rsquo;ll be in touch on WhatsApp and email.
            </p>
          )}
          {status === 'err' && (
            <p
              role="alert"
              className="mb-6 rounded-xl border border-[#f5c2c2] bg-[#fdecec] px-4 py-3 text-[14px] text-[#991b1b]"
            >
              Please check the form — your name, a valid email, a WhatsApp number with country
              code, your location, at least one country, and your consent are required.
            </p>
          )}
          {status === 'rate' && (
            <p
              role="alert"
              className="mb-6 rounded-xl border border-[#f5c2c2] bg-[#fdecec] px-4 py-3 text-[14px] text-[#991b1b]"
            >
              Too many requests — please try again later.
            </p>
          )}

          {/* Honeypot — visually hidden, off-screen, not announced. Bots fill it;
              humans don't. A non-empty value is silently dropped. */}
          <div aria-hidden="true" className="absolute -left-[9999px] top-0 h-0 w-0 overflow-hidden">
            <label htmlFor="wl-website">Leave this field empty</label>
            <input id="wl-website" type="text" name="website" tabIndex={-1} autoComplete="off" />
          </div>

          {/* Attribution from the page URL (capped again server-side). */}
          <input type="hidden" name="utm_source" value={utmValue(utmSource)} />
          <input type="hidden" name="utm_campaign" value={utmValue(utmCampaign)} />

          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <label htmlFor="wl-full-name" className={LABEL}>
                Full name
              </label>
              <input
                id="wl-full-name"
                type="text"
                name="full_name"
                required
                minLength={2}
                maxLength={WAITLIST_LIMITS.name}
                autoComplete="name"
                className={INPUT}
                placeholder="Asha Patel"
              />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
              <div className="flex flex-1 flex-col gap-2">
                <label htmlFor="wl-email" className={LABEL}>
                  Email
                </label>
                <input
                  id="wl-email"
                  type="email"
                  name="email"
                  required
                  maxLength={WAITLIST_LIMITS.email}
                  autoComplete="email"
                  className={INPUT}
                  placeholder="you@example.com"
                />
              </div>
              <div className="flex flex-1 flex-col gap-2">
                <label htmlFor="wl-phone" className={LABEL}>
                  WhatsApp number
                </label>
                <input
                  id="wl-phone"
                  type="tel"
                  name="phone"
                  required
                  maxLength={WAITLIST_LIMITS.phone}
                  autoComplete="tel"
                  className={INPUT}
                  placeholder="+1 555 123 4567"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="wl-location" className={LABEL}>
                Where are you? <span className="font-normal text-[#667085]">(city / state)</span>
              </label>
              <input
                id="wl-location"
                type="text"
                name="location"
                required
                maxLength={WAITLIST_LIMITS.location}
                autoComplete="address-level2"
                className={INPUT}
                placeholder="Fairfax, VA"
              />
            </div>

            <fieldset className="flex flex-col gap-3">
              <legend className={`mb-1 ${LABEL}`}>Where do you send money?</legend>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
                {WAITLIST_DESTINATIONS.map((c) => (
                  <label key={c.value} className="inline-flex items-center gap-2.5 text-[14px] text-[#334155]">
                    <input
                      type="checkbox"
                      name="destinations"
                      value={c.value}
                      className="h-4 w-4 accent-[#1e5fd6]"
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="flex items-start gap-3 text-[14px] leading-snug text-[#334155]">
              <input
                type="checkbox"
                name="consent"
                value="yes"
                required
                className="mt-0.5 h-4 w-4 shrink-0 accent-[#1e5fd6]"
              />
              <span>{WAITLIST_CONSENT_TEXT}</span>
            </label>

            <button type="submit" className={BTN}>
              Join waitlist
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
