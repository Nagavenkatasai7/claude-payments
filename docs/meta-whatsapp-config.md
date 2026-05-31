# SmartRemit — Meta WhatsApp Business Platform Configuration & Scaling Plan

> Audience: SmartRemit engineering. Goal: harden the Meta/WhatsApp side as far as
> possible **now** (developer / limited access, on the Meta test number, unverified
> business), and lay out exactly what's required to scale to a **verified, global,
> multi-tenant, high-volume** production deployment.
>
> Facts below are anchored to official Meta docs (2025–2026). Where a number is from
> general platform knowledge rather than a freshly-fetched page, it's marked *(verify)*.
> Sources listed at the bottom.

---

## 0. TL;DR — the five things that matter most

1. **CRITICAL / compliance:** Stop collecting **full bank account numbers + IFSC/routing in the WhatsApp chat.** WhatsApp policy: *"Don't … ask people to share full length individual payment card numbers, financial account numbers, personal ID card numbers, or other sensitive identifiers."* Move recipient bank-detail capture onto the **secure pay page** (web). The bot collects name + amount + country only; the link collects the rest. This also shrinks our own PII/storage risk.
2. **Templates are only needed *outside* the 24-hour window.** Most of our bot replies happen inside the customer-service window → free-form text, **free**, no template. We need approved **UTILITY** templates for the business-*initiated* messages: recipient delivery, scheduled-payment reminders, abandoned-payment nudges, review/hold updates, and verification reminders. Full paste-ready specs in §3.
3. **Our one existing template (`transfer_delivered`) is stale** — it was written for the old India-only **UPI** flow (hardcoded ₹, "UPI ID") and the old brand. It must be **rebuilt** for multi-currency + SmartRemit (§3).
4. **You cannot go global on the test number.** The test number is sandbox-only (small recipient allow-list, not for production). Real scale requires **registering a real number**; **Meta Business Verification** is what lifts you past **Tier 1 (1,000)** toward 10K → 100K + the verified blue checkmark (a new portfolio reaches Tier 1 without it). Roadmap in §5.
5. **Harden the inbound Meta webhook** (verify `X-Hub-Signature-256`), **subscribe to message-status webhooks** (delivered/read/failed → quality + failure handling), and add **rate-limit backoff** for errors `131056` / `131049`. Code plan in §6.

---

## 1. Current Meta state (as configured)

| Item | Value |
|---|---|
| Mode | **Developer / limited access**, unverified business |
| Phone | Meta **test number** +1 555-629-8293 (Phone Number ID `1118376434692938`) — sandbox |
| WABA | `1423798669516574` |
| Business Portfolio | `1420039710147462` (was restricted ~2026-05-22, restored after appeal) |
| Token | Permanent System-User token in `WHATSAPP_TOKEN` |
| Approved templates | `transfer_delivered` (en, UTILITY) — **stale**, India/UPI-era |
| Unsubmitted | `scheduled_payment_ready` — referenced in code, never created; cron falls back to free-form text |
| Recipient allow-list | Only verified test recipients can receive messages on the test number |

---

## 2. The messaging model (what's free, what needs a template)

**Customer-service (CS) window = 24h** from the user's last inbound message. Inside it you may send **free-form** text / interactive messages (**free**). Outside it, a **business-initiated** message must be a **pre-approved template**, and **UTILITY templates are also free when delivered inside an open CS window** (per-message pricing since **2025-07-01**; only template deliveries outside the window are billed, priced by category + recipient country). citemeta-pricing

**Scenario → channel map (our app):**

| Scenario | Recipient | Usually in CS window? | Needs template? |
|---|---|---|---|
| Quote / Approve-&-Pay card, all chat Q&A | sender | ✅ yes (active chat) | No — free-form (current) |
| Sender "delivered 🎉" confirmation | sender | ⚠️ usually, but mock/real delivery can lag >24h | **Yes** (fallback) → `transfer_delivered_sender` |
| Recipient delivery confirmation | recipient | ❌ recipient never messaged us | **Yes, always** → `transfer_delivered` (rebuild) |
| Scheduled-transfer "ready to approve" | sender | ❌ cron fires days later | **Yes** → `scheduled_payment_ready` |
| Abandoned quote / unpaid transfer nudge | sender | ❌ often outside window | **Yes** → `payment_reminder` |
| Compliance hold ("in review") | sender | ⚠️ maybe | **Yes** (fallback) → `transfer_in_review` |
| Released-after-review | sender | ❌ later | **Yes** → `transfer_released` |
| Cancelled / rejected | sender | ⚠️ maybe | **Yes** (fallback) → `transfer_cancelled` |
| Verification reminder (raise limit) | sender | ❌ T0 reminders fire later | **Yes** → `verification_reminder` |

**Rule of thumb to bake into code:** try free-form first when we believe we're in-window; on HTTP **470 / "outside window"**, fall back to the matching template (we already do 470→fallback for interactive sends; extend it to a template, not just plain text, for these business-initiated cases).

---

## 3. Template library — paste-ready specs (English, UTILITY)

Create each in **WhatsApp Manager → Account tools → Message templates → Create template**. Category **Utility**, Language **English** (code `en` — *not* `en_US`; our one approved template uses `en` and the code sends `language.code = "en"`). Body ≤ 1024 chars; header text ≤ 60; footer ≤ 60; button label ≤ 25 chars. Every `{{n}}` variable needs a **sample value** at submission. Keep them strictly transactional (no marketing words) so they stay UTILITY (Meta auto-recategorizes promo-sounding "utility" templates to MARKETING, which costs more and needs opt-in). citemeta-categorization

> **⚠️ Submit order matters — the 7-day category-lock (April 2025 rule).** If Meta judges a "UTILITY" template to be MARKETING, it re-categorizes it **with no 24-hour notice** and, for **7 days**, disables category review *and blocks creation of new UTILITY templates for the entire WABA*. Because we submit 8 at once, one promo-sounding template could **freeze creation of the rest**. **Order:** submit the clean transactional ones first (§3.1, §3.2, §3.5, §3.6, §3.7), then `scheduled_payment_ready` / `payment_reminder` (§3.3, §3.4), and submit `verification_reminder` (§3.8) **LAST**, after its rewrite. You have **60 days** to appeal a re-categorization (request a category review in Template Manager).

> Placeholders are positional `{{1}}, {{2}}, …`. "Sample" = what to type in the example fields. Dynamic-URL buttons allow exactly **one** variable and it must be the **suffix at the end** of the URL — so pay/verify link tokens must be **path-safe slugs** (no `/` or query chars in the `{{1}}` value).

### 3.1 `transfer_delivered` — recipient delivery confirmation (REBUILD)
- **Category:** Utility · **Language:** en
- **Body:**
  `Hi {{1}}, good news — you've received {{2}} from {{3}} via SmartRemit. It's been deposited to your bank account ending {{4}}.`
- **Footer:** `SmartRemit · smartremit.ai`
- **Samples:** {{1}}=`Priya`, {{2}}=`₹4,750`, {{3}}=`Anand`, {{4}}=`6789`
- Replaces the stale 4-param UPI version. Params now: recipient name, **amount+currency string** (multi-currency), sender name, **last-4 of account** (never the full number).

### 3.2 `transfer_delivered_sender` — sender delivery confirmation (out-of-window fallback)
- **Category:** Utility · **Language:** en
- **Body:**
  `Your SmartRemit transfer of {{1}} to {{2}} has been delivered. Reference: {{3}}.`
- **Footer:** `SmartRemit · smartremit.ai`
- **Samples:** {{1}}=`$50.00`, {{2}}=`Priya`, {{3}}=`tx_a1b2c3`

### 3.3 `scheduled_payment_ready` — recurring-transfer approval (with pay link)
- **Category:** Utility · **Language:** en
- **Body:**
  `Hi {{1}}, your scheduled transfer of {{2}} to {{3}} is ready for approval. Review and confirm using the button below.`
- **Buttons:** **Call-to-action → Visit website**, type **Dynamic**, label `Review & Pay`, URL `https://smartremit.ai/pay/{{1}}` (one dynamic suffix variable).
- **Samples:** body {{1}}=`Anand`, {{2}}=`$100.00`, {{3}}=`Priya`; button {{1}}=`draft_abc123`
- Replaces the current free-form cron text (which only lands if the user happens to be in-window).

### 3.4 `payment_reminder` — abandoned/unpaid transfer nudge
- **Category:** Utility · **Language:** en
- **Body:**
  `Hi {{1}}, your transfer of {{2}} to {{3}} is still pending. You can complete it using the button below.`
- **Buttons:** CTA → Visit website, Dynamic, label `Complete Payment`, URL `https://smartremit.ai/pay/{{1}}`.
- **Samples:** body {{1}}=`Anand`, {{2}}=`$50.00`, {{3}}=`Priya`; button {{1}}=`draft_abc123`

### 3.5 `transfer_in_review` — compliance hold
- **Category:** Utility · **Language:** en
- **Body:**
  `Hi {{1}}, your transfer of {{2}} to {{3}} is being reviewed by our team for security. We'll update you shortly — no action is needed right now.`
- **Samples:** {{1}}=`Anand`, {{2}}=`$1,000.00`, {{3}}=`Priya`

### 3.6 `transfer_released` — cleared after review
- **Category:** Utility · **Language:** en
- **Body:**
  `Good news {{1}} — your transfer of {{2}} to {{3}} has cleared review and is on its way.`
- **Samples:** {{1}}=`Anand`, {{2}}=`$1,000.00`, {{3}}=`Priya`

### 3.7 `transfer_cancelled` — could not be completed
- **Category:** Utility · **Language:** en
- **Body:**
  `Hi {{1}}, your transfer of {{2}} to {{3}} could not be completed and any charge has been reversed. Reply here if you have questions.`
- **Samples:** {{1}}=`Anand`, {{2}}=`$200.00`, {{3}}=`Priya`

### 3.8 `verification_reminder` — pending-verification nudge (with KYC link)
- **Category:** Utility · **Language:** en
- **Body:**
  `Hi {{1}}, identity verification is still pending on your SmartRemit account. Until it's complete, some transfers may be limited. You can finish it using the button below.`
- **Buttons:** CTA → Visit website, Dynamic, label `Verify Now`, URL `https://smartremit.ai/verify/{{1}}` *(or the KYC provider URL pattern)*.
- **Samples:** body {{1}}=`Anand`; button {{1}}=`sess_xyz`
- **Why this wording:** the original "raise your limit to $X/day … takes 2 minutes" reads as an upsell/incentive — Meta would re-categorize it to MARKETING (and AUTHENTICATION is only for verification *codes*, not identity nudges). Stating a factual pending-account status keeps it UTILITY. **Submit this one LAST** (see §3 category-lock note).

### (Optional / later) `smartremit_otp` — AUTHENTICATION
- Only if we ever send login/verification **codes** over WhatsApp. Authentication templates use Meta's fixed format + a **Copy-code** button and are billed at authentication rates **even inside the 24h window** (no free-in-window benefit, unlike UTILITY/free-form). We currently verify via a hosted KYC link, so **not needed now** — listed for completeness.

**Marketing templates:** none for now. Promotional/re-engagement messages are MARKETING (separate opt-in, billed, per-user marketing rate-limit `131049`). Defer until post-verification and only with explicit marketing opt-in.

---

## 4. Business profile & display name (do now)

In **WhatsApp Manager → Phone number → Profile** (and Business Portfolio settings):
- **Display name:** `SmartRemit` (must relate to the business; generic terms get rejected — "SmartRemit" is fine). On the **test number** the display name is effectively a sandbox label; the *reviewed, public* display name is approved during **real-number registration after Business Verification** (§5). Set it to `SmartRemit` now and re-confirm at registration.
- **About / description:** "Send money home, bank-to-bank, via WhatsApp. smartremit.ai"
- **Category / vertical:** Finance.
- **Website:** `https://smartremit.ai` · **Email:** support@smartremit.ai · **Address** as applicable.
- **Profile photo:** the SmartRemit `SR` mark.

---

## 5. Scaling roadmap — what verification unlocks (needed for global multi-user)

The test number **cannot** serve real customers. To go live globally:

1. **Add a real phone number** to the WABA (a number not already on WhatsApp) and **register** it (sets the public `verified_name`/display name, reviewed by Meta).
2. **Complete Meta Business Verification** for the Business Portfolio (legal business docs). **2025 change:** a new portfolio can reach **Tier 1 (1,000)** on quality + volume **without** verification — verification is what unlocks climbing **past 1,000** (to 10K / 100K) and the **verified-business blue checkmark**. A brand-new portfolio still **starts at 250** unique recipients / 24h outside the CS window, portfolio-wide. citemeta-limits
3. **Messaging tiers** (max unique recipients you can *initiate* to per rolling 24h): **250 → 1K → 10K → 100K → unlimited**. Since **Oct 2025**, all numbers in a portfolio **share the portfolio's highest tier**, and a newly added number **instantly inherits** it (it does *not* restart at 250). Tiers **auto-upgrade** (re-evaluated roughly every **6 hours**) when you use **≥ 50% of your current limit within a 7-day window** while keeping **quality** high; verification gates the jump **past 1,000**. citemeta-limits
4. **Throughput:** Cloud API **auto-scales**; default ~**80 messages/sec**, up to **~1,000 mps** with sustained volume/quality *(verify current numbers on the throughput doc)*. No infra work on our side — it's Meta-managed — but our **sender code must tolerate bursts/queuing**.
5. **Quality rating** (green/yellow/red) is **per phone number** and gates tier upgrades. It drops from blocks, "not useful" reports, and blasting cold/low-opt-in users. Keep messages UTILITY + strictly transactional + well-paced. A red number can be **paused** from sending.

**Multi-tenant note (important for our `partnerId` model):** messaging limits/quality live at the **portfolio + per-number** level, not per app-tenant. Two viable shapes as we scale:
- **(a) One platform number** for all SmartRemit traffic — simplest; one quality rating + one tier to manage; all partners share it.
- **(b) Per-partner numbers / WABAs** — isolates one partner's quality/throughput from another's and supports partner-branded sender identities, at the cost of N verifications + N quality ratings to manage. Recommended only once a partner's volume justifies it. Our code already carries `partnerId` everywhere, so routing a partner to its own `WHATSAPP_PHONE_NUMBER_ID` later is a config change, not a rearchitecture. (Note: since Oct 2025 messaging *limits* are shared at the portfolio's highest tier, so per-partner numbers buy you **quality-rating isolation, throughput isolation, and partner-branded sender identity** — not extra limit headroom.)

---

## 6. Webhook & sender hardening (do now / code)

1. **Verify the inbound Meta webhook signature.** The `POST /api/whatsapp` receiver should validate **`X-Hub-Signature-256`** (HMAC-SHA256 of the raw body with the **App Secret**) before processing — otherwise anyone can POST forged "messages" to our bot. (We already do HMAC verification for the *payment* webhook; mirror that pattern. Needs a new `META_APP_SECRET` env var.) **Confirmed:** `route.ts` currently validates only the GET verify-token, not the POST signature. Compute the HMAC over the **raw, unparsed body** (`await req.text()` *before* `JSON.parse`) — Next.js auto-JSON-parsing breaks the check; mirror the payment-webhook's raw-body pattern.
2. **Subscribe to message-status webhooks** (`sent` / `delivered` / `read` / `failed`). Use them to (a) track delivery for the dashboard, (b) surface genuine **send failures** (template paused/disabled, quality drop, undeliverable number) — note `131047`/`470` is just the *outside-24h-window* signal that triggers a template fallback (§6.4), not an anomaly to alert on, (c) feed quality monitoring. We currently ignore status events.
3. **Idempotency / dedup on inbound `message.id` — ✅ ALREADY DONE.** `store.markMessageSeen` (Redis `msg:<wamid>`, SET-NX, 600 s TTL) gates the inbound webhook at `src/app/api/whatsapp/route.ts` — a retried/replayed webhook is dropped before any processing. No work needed; kept here for completeness.
4. **Rate-limit-aware sender:** wrap `sendText`/`sendTemplate` with retry/backoff that recognizes:
   - **`131056`** — too many messages to the *same user* (1 msg / 6 s) → exponential backoff, retry. citemeta-perf
   - **`131049`** — recipient-side **cross-business MARKETING frequency cap** (a user can receive only ~2 marketing-category messages/day from *all* businesses combined — you can trip it on your very first marketing message to them). Applies **only to MARKETING templates**, so with our UTILITY-only set it should essentially **never fire today**. If we ever add marketing: don't immediately retry — back off on **increasing** intervals (≈12h → 24h → 48h; the cap duration varies per user), fall back to a UTILITY template, or suppress. citemeta-perf
   - **`470` / `131047`** — outside CS window → switch to the matching **template** (§3).
   - Generic 5xx / throttling → bounded exponential backoff with jitter.
5. **Pace business-initiated blasts** (scheduled-payment cron, reminders): spread sends, don't fan out the whole schedule batch in one burst; respect per-user 6s spacing.

---

## 7. Opt-in & consent (mandatory, especially for finance)

- You may message a user only if they **gave you their number** *and* **opted in** to receive messages; opt-in must state the **business name + intent** and you must honor opt-outs. citemeta-optin
- For us, opt-in is naturally satisfied when a **sender** messages our number first (they initiated). But **recipients** never messaged us — sending them `transfer_delivered` relies on the **sender's** consent/relationship; keep these strictly transactional UTILITY (allowed) and never marketing.
- **Capture + store explicit opt-in** for senders (e.g., a one-time "Reply YES to get transfer updates from SmartRemit" on first contact, or a consent checkbox on the pay page) with a timestamp, so we can prove consent. Add an `optInAt` field to the Customer record. (Forward-looking: if MARKETING templates are ever added — deferred — Meta requires opt-in that **specifically names marketing intent**, separate from this transactional consent; don't treat `optInAt` as marketing consent.)
- Honor **STOP/opt-out**: detect "STOP/UNSUBSCRIBE", flag the customer, and suppress business-initiated templates to them.
- **Financial-data rule (the big one):** *"Don't share or ask people to share full length individual payment card numbers, financial account numbers, personal ID card numbers, or other sensitive identifiers."* → **move recipient bank-detail collection off WhatsApp** (see §8). citemeta-policy

---

## 8. The bank-detail collection fix (HIGH — compliance + data minimization)

**Today:** the bot asks *"What are their bank details in <country>?"* and the user types the **full account number + IFSC/routing/IBAN** into WhatsApp; we parse and store it. This both (a) **violates** the WhatsApp policy quoted above and (b) makes us store sensitive financial identifiers captured from a chat transcript. (We already mask everything the bot *sends back* — last-4 only on the card and in chat, per the recent hardening — so the exposure is specifically the **inbound user message** and the stored `payoutDestination`, not bot echoes.)

**Fix:** the bot collects **recipient name + destination country + amount** in chat; **bank details are entered on the secure pay page** (already HTTPS, already where the payment happens). The Approve-&-Pay link becomes "enter the recipient's bank details + pay." Net effect:
- Compliant with WhatsApp's financial-data rule.
- We stop ingesting full account numbers via chat; the chat only ever holds masked/last-4.
- Cleaner UX: typing an IBAN into WhatsApp is error-prone anyway.

This touches `src/lib/prompt.ts` (drop the "ask for bank details" step + the per-country field prompts), the tool/draft flow (`send_approve_picker` / draft no longer needs `payout_destination` up front), and the pay page (add a bank-details form before payment). **Scoped as its own batch** — call it out before building.

---

## 9. Do-now checklist (limited/dev access)

- [ ] Set **display name** `SmartRemit` + business profile (vertical Finance, website smartremit.ai). §4
- [ ] **Rebuild** `transfer_delivered` (multi-currency, SmartRemit, last-4). §3.1
- [ ] Create the **8 UTILITY templates** in §3 — submit the clean transactional ones first, `verification_reminder` **last** (7-day category-lock risk). Review ~minutes–hours (up to 24h). §3
- [ ] Add real **test recipients** to the allow-list to exercise templates end-to-end on the sandbox.
- [ ] **Code:** verify `X-Hub-Signature-256` on the inbound webhook (+ `META_APP_SECRET`). §6.1
- [ ] **Code:** template constants + param builders for the new templates; 470→template fallback. §6.4
- [ ] **Code:** rate-limit backoff (131056) + message-status webhook handling. (Inbound `message.id` dedup is already implemented ✓.) §6.2–6.4
- [ ] **Plan:** move bank-detail collection to the pay page (separate batch). §8
- [ ] **Plan:** opt-in capture + STOP handling (`optInAt`, suppression). §7

## 10. Pre-production (requires verification — roadmap)

- [ ] Register a **real phone number**; set/approve public display name.
- [ ] Complete **Meta Business Verification** (required to scale **past Tier 1 / 1,000** to 10K → 100K; unlocks the **verified-business blue checkmark**). A new portfolio reaches Tier 1 without it.
- [ ] Add **message-status webhook** processing + a delivery/quality view in the dashboard. §6.2
- [ ] Decide **one number vs per-partner numbers** as volume grows. §5
- [ ] **Localization:** add HI, then ES / AR / TL / FR / PT-BR templates per active corridor (each separately approved). 
- [ ] Warm-up plan: ramp business-initiated volume gradually to protect quality rating. §5

---

## Sources
- Messaging limits & tiers: https://developers.facebook.com/docs/whatsapp/messaging-limits/
- Pricing (per-message, 2025-07-01; free utility-in-window): https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing/
- Template categorization (UTILITY/MARKETING/AUTH; auto-recategorization): https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization
- Business phone numbers / test numbers / registration: https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers/
- Per-user rate limits & error codes (131056/131049, burst): https://developers.facebook.com/docs/whatsapp/tips-and-tricks/send-message-performance/
- Throughput: https://developers.facebook.com/docs/whatsapp/throughput
- Opt-in: https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in
- Business Messaging Policy (financial-data prohibition; opt-in): https://business.whatsapp.com/policy
