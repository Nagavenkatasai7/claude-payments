# WhatsApp Template Setup Guide — Field-by-Field

> Exactly what to click and type in **Meta WhatsApp Manager** to create every
> template SmartRemit needs. Written 2026-06-11. Approval usually takes minutes
> for AUTHENTICATION templates and up to ~24h for UTILITY ones.
>
> WABA: `1423798669516574` · Test number: +1 555-629-8293

---

## 0. Before you start — the five rules that cause rejections

1. **Language must be "English" (code `en`)** — NOT "English (US)" (`en_US`).
   The application sends `language: { code: "en" }`; a template approved only as
   `en_US` will fail with "template not found". When the language dropdown offers
   both, pick plain **English**.
2. **Every `{{n}}` variable requires a sample value** at submission. The
   "Add sample" panel appears after you type a variable — fill it or the Submit
   button stays disabled / review rejects it.
3. **The body cannot START or END with a variable**, and variables can't be
   adjacent (`{{1}} {{2}}` with nothing between is rejected). All bodies below
   already respect this — paste them verbatim.
4. **Dynamic URL buttons allow exactly ONE variable, only at the END of the URL**
   (`https://smartremit.com/pay/{{1}}` ✅ — `https://{{1}}.smartremit.com` ❌).
   The sample for a URL variable is just the suffix (e.g. `draft_abc123`).
5. **Submission order matters (the 7-day category lock).** If Meta decides a
   "Utility" template is actually Marketing, it re-categorizes it without notice
   and **blocks creating new Utility templates on the whole WABA for 7 days**.
   Submit in the order of this document: the Authentication one first, then the
   plain transactional ones, then the URL-button ones, and `payment_reminder`
   **last**.

**Where everything lives:** [business.facebook.com](https://business.facebook.com)
→ select the SmartRemit portfolio → **WhatsApp Manager** → left sidebar
**Account tools → Message templates** → blue **Create template** button.

---

## 1. `verification_code` — AUTHENTICATION ⚡ (do this one first)

This fixes portal login/register/reset codes not arriving. Authentication
templates are *form-built* — Meta writes the message text; you only configure
options.

| Field | What to enter |
|---|---|
| Category | **Authentication** |
| Name | `verification_code` — exactly this, lowercase, underscore. (It's the app's default; any other name requires setting the `WHATSAPP_AUTH_TEMPLATE` env var.) |
| Language | **English** |
| Code delivery method | **Copy code** (one-tap copy button) |
| "Add security recommendation" | ✅ check it (adds "For your security, do not share this code.") |
| "Add expiry time" | ✅ check it → **5 minutes** (matches the app's 5-minute code TTL) |

There is no body to write and no samples to add — Meta renders:
*"{{1}} is your verification code. For your security, do not share this code.
This code expires in 5 minutes."* with a **Copy code** button.

**After approval:** nothing to configure if you used the exact name. If you chose
a different name: `vercel env add WHATSAPP_AUTH_TEMPLATE production` → type the
name when prompted (never pipe the value).

---

## 2. `transfer_delivered_v2` — Utility (recipient delivery confirmation)

Replaces the stale UPI-era `transfer_delivered`. **Do NOT edit the old one** —
editing an approved template sends it back to review and breaks live sends
meanwhile. Create this as a new template; the code switch happens after approval
(see §8).

| Field | What to enter |
|---|---|
| Category | **Utility** |
| Name | `transfer_delivered_v2` |
| Language | **English** |
| Header | None (leave off) |
| Body | `Hi {{1}}, good news — you've received {{2}} from {{3}} via SmartRemit. It's been deposited to your bank account ending {{4}}.` |
| Footer | `SmartRemit · smartremit.com` |
| Buttons | None |

**Samples** (the panel under the body):

| Variable | Sample to type |
|---|---|
| `{{1}}` | `Priya` |
| `{{2}}` | `₹4,750` |
| `{{3}}` | `Anand` |
| `{{4}}` | `6789` |

> Why these params: `{{2}}` is a pre-formatted amount **with its currency symbol**
> (the app formats per destination currency — multi-corridor ready), and `{{4}}`
> is the **last 4 digits only** of the account — the full number never leaves the
> encrypted store.

---

## 3. The verification-status family — Utility (4 templates, same body)

These notify a customer when their KYC state changes. The app already calls them
by these exact names (it falls back to plain text until they're approved). Create
**four** templates — identical except the name; the status sentence arrives as
`{{2}}` at send time.

| Field | What to enter |
|---|---|
| Category | **Utility** |
| Names (one template each) | `verification_needed` · `verification_in_progress` · `verification_verified` · `verification_failed` |
| Language | **English** |
| Body (same for all four) | `Hi {{1}}, an update on your SmartRemit account: {{2}} Reply here if you have any questions.` |
| Footer | `SmartRemit · smartremit.com` |
| Buttons | None |

**Samples** — `{{1}}` = `Anand` for all four; `{{2}}` per template:

| Template | `{{2}}` sample |
|---|---|
| `verification_needed` | `Please verify your identity to start sending money.` |
| `verification_in_progress` | `Your identity verification is in progress.` |
| `verification_verified` | `You're verified! You can now send money.` |
| `verification_failed` | `We couldn't verify your identity. Please reply here and we'll help.` |

> The trailing "Reply here if you have any questions." exists because Meta
> rejects bodies that **end** on a variable — don't delete it.

**After approval:** nothing to configure — the names match the app's defaults.
(Env overrides exist if you ever rename: `WHATSAPP_VERIFICATION_NEEDED_TEMPLATE`,
`..._IN_PROGRESS_...`, `..._VERIFIED_...`, `..._FAILED_...`.)

---

## 4. `scheduled_payment_ready` — Utility with a URL button

Sent by the daily cron when a recurring transfer is due — the customer is almost
always outside the 24h window, so today these only land by luck. The app already
calls this exact name.

| Field | What to enter |
|---|---|
| Category | **Utility** |
| Name | `scheduled_payment_ready` |
| Language | **English** |
| Body | `Hi {{1}}, your scheduled transfer of {{2}} to {{3}} is ready for approval. Review and confirm using the button below.` |
| Footer | `SmartRemit · smartremit.com` |
| Buttons | **Add button → Call to action → Visit website** |
| — Button text | `Review & Pay` |
| — URL type | **Dynamic** |
| — URL | `https://smartremit.com/pay/{{1}}` |

**Samples:**

| Variable | Sample |
|---|---|
| Body `{{1}}` | `Anand` |
| Body `{{2}}` | `$100.00` |
| Body `{{3}}` | `Priya` |
| Button URL `{{1}}` | `draft_abc123` |

> The button's `{{1}}` is independent of the body's `{{1}}` — Meta numbers them
> per component. The sample is just the path suffix, no slashes.

---

## 5. Batch 3 — recommended fallbacks (same UI steps; submit after 1–4 approve)

All: Category **Utility**, Language **English**, Footer `SmartRemit · smartremit.com`, no header.

### 5.1 `transfer_delivered_sender`
- Body: `Your SmartRemit transfer of {{1}} to {{2}} has been delivered. Reference: {{3}}.`
- Samples: `{{1}}`=`$50.00` · `{{2}}`=`Priya` · `{{3}}`=`tx_a1b2c3`

### 5.2 `transfer_in_review`
- Body: `Hi {{1}}, your transfer of {{2}} to {{3}} is being reviewed by our team for security. We'll update you shortly — no action is needed right now.`
- Samples: `Anand` · `$1,000.00` · `Priya`

### 5.3 `transfer_released`
- Body: `Good news {{1}} — your transfer of {{2}} to {{3}} has cleared review and is on its way.`
- Samples: `Anand` · `$1,000.00` · `Priya`

### 5.4 `transfer_cancelled`
- Body: `Hi {{1}}, your transfer of {{2}} to {{3}} could not be completed and any charge has been reversed. Reply here if you have questions.`
- Samples: `Anand` · `$200.00` · `Priya`

### 5.5 `payment_reminder` — SUBMIT LAST (highest re-categorization risk)
- Body: `Hi {{1}}, your transfer of {{2}} to {{3}} is still pending. You can complete it using the button below.`
- Button: Call to action → Visit website → text `Complete Payment` → URL type **Dynamic** → `https://smartremit.com/pay/{{1}}`
- Samples: body `Anand` · `$50.00` · `Priya`; button `draft_abc123`

---

## 6. What NOT to create

- **A transaction-OTP template** — the pay-page code is sent as free-form text by
  design (the customer is actively paying, always inside the 24h window).
- **`verification_reminder` / any marketing nudge** — with the KYC gate now
  partner opt-in it's unneeded, and reminder/upsell wording is exactly what
  triggers the Marketing re-categorization + 7-day lock.
- **Edits to the old `transfer_delivered`** — leave it live until v2 is approved
  and the code is switched.

---

## 7. Submission checklist (in order)

| # | Template | Category | Buttons | Status after this guide |
|---|---|---|---|---|
| 1 | `verification_code` | Authentication | Copy code | ⬜ submit FIRST |
| 2 | `transfer_delivered_v2` | Utility | — | ⬜ |
| 3 | `verification_needed` | Utility | — | ⬜ |
| 4 | `verification_in_progress` | Utility | — | ⬜ |
| 5 | `verification_verified` | Utility | — | ⬜ |
| 6 | `verification_failed` | Utility | — | ⬜ |
| 7 | `scheduled_payment_ready` | Utility | Dynamic URL | ⬜ |
| 8 | `transfer_delivered_sender` | Utility | — | ⬜ |
| 9 | `transfer_in_review` | Utility | — | ⬜ |
| 10 | `transfer_released` | Utility | — | ⬜ |
| 11 | `transfer_cancelled` | Utility | — | ⬜ |
| 12 | `payment_reminder` | Utility | Dynamic URL | ⬜ submit LAST |

If any template comes back **Rejected**: read the reason in Template Manager
(usually a missing sample or flagged wording), fix, resubmit — rejections don't
trigger the 7-day lock; re-categorizations do. You have 60 days to appeal a
re-categorization via "Request review".

---

## 8. After approval — the app side

1. **Names 1, 3–7 need zero configuration** — they match the app's defaults.
2. **`transfer_delivered_v2`**: tell the engineering session it's approved. The
   swap is a deliberate lockstep change (the app currently sends the OLD 4-param
   order to the OLD template; the constant + param builder flip together in one
   PR, verified live).
3. **Batch 3 templates** are not yet wired to code paths — approving them now
   just banks the 24h review wait; wiring follows.
4. **Sandbox caveat:** on the test number, even approved templates deliver only
   to recipients on the test allow-list. The limit disappears when a real number
   is registered (see `docs/meta-whatsapp-config.md` §5 for the verification
   roadmap).

## 9. Verifying each template works

- `verification_code`: log out of the portal → `/account/login` → enter phone +
  password → the code should now arrive **even if you haven't messaged the bot in
  >24h** — that's the whole point. Check the copy-code button works.
- `scheduled_payment_ready`: create a schedule via the bot ("send $50 to Anita
  every Friday"), then ask engineering to fire the cron once — the message should
  arrive with the working **Review & Pay** button.
- `verification_*`: trigger a KYC state change (start/approve/reject a
  verification on a gate-enabled partner) and confirm the templated message.
- `transfer_delivered_v2`: only after the lockstep code swap — run one mock
  transfer end-to-end and confirm the recipient gets the new wording with the
  correct amount + last-4.
