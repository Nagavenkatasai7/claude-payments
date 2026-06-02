# Claude-in-Chrome verification prompt — Phase 1 activation (2026-06-02)

Paste everything in the fenced block below into Claude-in-Chrome. It verifies the
release that (a) made staff password hashing async, (b) activated the `/account`
customer portal in prod, and (c) hardened register/reset so internal errors never
leak. The real risk is a **regression** in staff login; the portal is new.

```
ROLE / MISSION
You are a careful QA tester driving a live web app in Chrome. You are verifying a backend
release of "SmartRemit" — a WhatsApp-based US→India money-transfer service — at
https://claude-payments.vercel.app. This release (1) changed how STAFF passwords are
verified (the hashing became asynchronous), (2) turned on a brand-new CUSTOMER account
portal at /account, and (3) hardened the sign-up/reset error handling. NO real money moves
— everything is mocked — so you may create throwaway test data freely. Work through all
three PARTS, record PASS/FAIL with a one-line evidence note for each numbered check, and
list anything that fails at the end ranked by severity. Do not stop early.

GROUND RULES
- Do NOT ask me for, or type, any passwords yourself for the staff login. When a step needs
  staff credentials, PAUSE and ask me to type them, then continue.
- For the customer portal, INVENT a throwaway phone number and email (e.g. a +1 number you
  make up, and test+something@example.com). It is fine to create a test account in prod.
- Never click anything that would send a real WhatsApp message to a real person.
- The customer portal is intentionally NOT yet linked from the homepage — reach its pages by
  typing the URLs directly.

=====================================================================
PART 1 — STAFF REGRESSION (the real risk: did async password hashing break login?)
=====================================================================
1A. Go to https://claude-payments.vercel.app/login . PASS if you see the heading
    "Staff sign in" and a username + password form with a sign-in button. FAIL on a 500 /
    blank page.
1B. Ask me to type the staff username + password, then submit.
    PASS if you land on the admin dashboard at /admin-dashboard showing an "Overview" page
    with four metric cards titled "Commission today", "Volume today", "Transactions today",
    and "Flagged today". FAIL if login is rejected with correct credentials (that would mean
    the async-hash change broke verification), or you get a 500.
1C. In the left sidebar, click through these pages in turn and confirm each renders without
    an error overlay or blank screen: Transactions, Schedules, Customers, Compliance,
    Analytics. (Team / Partners / Corridors may or may not appear depending on the account's
    role — that's fine.) PASS if each page you can see renders content. FAIL on any 500 /
    crash / error boundary.
1D. Press Cmd-K (or Ctrl-K). PASS if a command palette opens and you can type to filter and
    Escape to close. (Minor: if it doesn't open, note it but don't fail the release.)
1E. Sign out (top-right menu / avatar). PASS if you return to the staff /login screen.

=====================================================================
PART 2 — PUBLIC LANDING UNCHANGED
=====================================================================
2A. Go to https://claude-payments.vercel.app/ . PASS if the SmartRemit marketing landing
    page renders normally (hero + content, no error). This release should not have touched it.

=====================================================================
PART 3 — NEW CUSTOMER PORTAL (/account) — renders + graceful, NO config leak
=====================================================================
NOTE BEFORE YOU START: the portal's encryption keys ARE now set in production, so creating an
account should SUCCEED and advance to a "enter your code" screen. BUT the WhatsApp code itself
will NOT actually arrive — the Meta one-time-passcode message template is still pending
approval. So "the code never arrives / I can't finish verifying" is the EXPECTED, CORRECT
state here — it is NOT a failure. You are verifying that the pages render and that sign-up
advances *gracefully*, not that you can complete a login.

3A. Go to https://claude-payments.vercel.app/account/login . PASS if you see "Sign in to your
    account", a "WhatsApp phone number" field, a "Password" field, a "Continue" button, and
    links "New here? Create an account" and "Forgot password?". FAIL on a 500 / blank page.
3B. Go to /account/register . PASS if you see "Create your account" with "WhatsApp phone
    number", "Email", and "Password" fields, a reassurance line about your details being
    encrypted, and a "Create account" button.
3C. On /account/register, fill in a made-up phone number, a test email, and a password of at
    least 8 characters, then submit.
    PASS if it ADVANCES to a verification screen that says something like "Enter the 6-digit
    code we sent to your WhatsApp ••• ••• <last 4 digits>" with a "Verification code" box and
    a "Verify" button.
    >>> CRITICAL FAIL CONDITIONS for 3C (report loudly if you see ANY of these):
        - a 500 / Application error / blank crash page, OR
        - an on-screen error message that contains the words "FIELD_ENCRYPTION_KEY",
          "32 bytes", "undefined", or a code stack trace. (Those would be an internal config
          error leaking to the customer — the exact bug this release fixed.)
        A plain, friendly message like "Could not create your account. Please try again." is
        acceptable (not ideal, but not a leak) — note it but treat as a soft pass.
3D. (Negative test) Go to /account/login and try to sign in with a DIFFERENT made-up phone
    number that you have NOT registered, and any password. PASS if you get a single generic
    message "Invalid phone or password." (It must NOT say whether the number exists — that's
    the privacy property.) FAIL if it reveals "no such account" vs "wrong password", or 500s.
3E. Go to /account/reset . PASS if you see "Reset your password", a "WhatsApp phone number"
    field, and a "Send reset code" button. Submitting a made-up number should show a neutral
    message like "If that number has an account, we sent a reset code." (it must NOT confirm
    whether the number exists). FAIL on a 500.

=====================================================================
REPORT
=====================================================================
Give me a table: check | PASS/FAIL | evidence. Then call out, in priority order, any FAILs —
especially any PART 1 staff-login regression (highest severity) or any 3C config-leak (high
severity). If everything passed, say so plainly and confirm the only "incomplete" item was
the expected OTP delivery, which is gated on the pending Meta template.
```
