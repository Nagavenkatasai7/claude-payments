# Claude-in-Chrome verification — full session (2026-06-03)

Covers everything built/fixed this session that a browser can verify: the landing fix, the admin
dashboard, the KYC sidebar + page + columns + review/approve flow, and the customer portal. A demo
customer (`+1 555 000 9999`, in `pending_review`) is staged so the review/approve flow is testable.
Paste the block below into Claude-in-Chrome.

```
ROLE / MISSION
You are a meticulous QA tester driving a live web app in Chrome. You are verifying the SmartRemit
admin dashboard, customer portal, and marketing site at https://claude-payments.vercel.app . Work
through every PART below, record PASS/FAIL with one line of evidence per numbered check, and list any
failures at the end ranked by severity. ALL DATA IS TEST DATA — a demo customer "+15550009999" has
been staged for you. Do not stop early.

GROUND RULES
- Do NOT type passwords yourself. When a step needs staff login, PAUSE and ask me to enter the
  credentials, then continue.
- Some behaviors run only over WhatsApp (the bot) and cannot be driven from a browser — PART 7 lists
  those; just note them, don't try to test them.

PART 1 — PUBLIC LANDING PAGE (the testimonials fix)
1A. Open https://claude-payments.vercel.app/ . PASS if the marketing page renders (hero "Send money
    home. Right from WhatsApp.", a live rate, FAQ) with no error.
1B. Scroll to the section headed "Built for families who send money home." PASS if the three cards
    are now PRODUCT PROMISES — labelled "Honest pricing", "Verified & protected", and "Right from
    WhatsApp" — NOT placeholder text. FAIL if you see any "[PLACEHOLDER testimonial …]" or "[Name,
    city]" text anywhere (the bug we fixed). The line "We'd love to earn your trust — try a first
    transfer free." should still be below them.

PART 2 — STAFF ADMIN (regression + the redesign)
2A. Open /admin-dashboard . If it redirects to /login, ask me to sign in (this also confirms staff
    login still works after the password-hashing change). PASS if you land on an "Overview" page with
    four metric cards: "Commission today", "Volume today", "Transactions today", "Flagged today".
2B. In the left sidebar, click through Transactions, Schedules, Customers, Compliance, Analytics — PASS
    if each renders content with no 500/error overlay.
2C. Press Cmd-K (or Ctrl-K). PASS if a command palette opens, typing "kyc" filters to a "KYC" entry,
    and Escape closes it.
2D. Narrow the browser window to a phone-ish width (~390px). PASS if the layout stays usable (sidebar
    collapses to a menu/drawer, no horizontal-scroll breakage).

PART 3 — KYC SIDEBAR ITEM + PAGE (new)
3A. In the sidebar, confirm there is a "KYC" item (its own entry, between "Compliance" and
    "Analytics", with a person-with-check icon). Click it. PASS if it opens /admin-dashboard/kyc with
    the page title "KYC" and subtitle "Identity verification — review queue & status".
3B. PASS if the page shows a row of status tiles (In review / Verified / Grandfathered / Pending /
    Not started / Rejected) as colored pills with counts, AND a "Needs KYC review" card listing
    customers — including a row for "+15550009999" with a "Review" link.

PART 4 — KYC COLUMN ON THE TABLES (new)
4A. Open /admin-dashboard/customers . PASS if the table has a "KYC" column (between "Tier" and
    "Lifetime sent") and each row shows a colored status pill — the demo customer "+15550009999" row
    should show a gray "Pending" pill plus a blue "In review" badge.
4B. Open /admin-dashboard/transactions . PASS if the table has a "KYC" column right after "Tier"
    showing the sender's status pill per row (rows whose sender has no record show a neutral "—").

PART 5 — KYC REVIEW + APPROVE FLOW (Phase 2 — the core human-review gate)
5A. From the KYC page (PART 3) or the Customers list, open the demo customer "+15550009999". PASS if
    the customer detail page shows an "Identity & KYC" card whose details include: Status "pending",
    Review state "pending_review", an Inquiry value starting "inq_", ID last 4 "••••6789", and
    Screening "Clear". (No 500 — that page had a bug earlier that's now fixed.)
5B. PASS if there is a review panel reading Persona "passed — confirm to approve" with a REQUIRED
    reason box and "Approve KYC" / "Reject KYC" buttons, and a "KYC audit trail" list below showing a
    "persona · inquiry.completed" entry.
5C. (Negative) Click "Approve KYC" with the reason box EMPTY. PASS if it refuses to submit / reports a
    required-reason validation (the reason is mandatory).
5D. Type a reason like "Verified during full-session QA" and click "Approve KYC". PASS if the page
    reloads showing Status "verified" / Review state "approved", the review panel is gone, and a NEW
    audit entry appears. CHECK THE ACTOR: it should read the reviewer as a display-name-plus-username
    like "Main Admin (forextransfer)" — NOT a bare username (the attribution fix). Record what you see.
5E. Go back to /admin-dashboard/kyc — PASS if "+15550009999" is NO LONGER in the "Needs KYC review"
    queue (approving removed it).

PART 6 — CUSTOMER PORTAL (Phase 1)
6A. Open /account/login . PASS if it shows "Sign in to your account", a "WhatsApp phone number" field,
    a "Password" field, a "Continue" button, and "New here? Create an account" + "Forgot password?".
6B. Open /account/register . PASS if it shows "Create your account" with phone / Email / Password
    fields + a "Create account" button. Submit a MADE-UP phone, a test email, and an 8+ char password.
    PASS if it advances gracefully (e.g. a verification screen or a friendly message) and you see NO
    raw config error — specifically NO "FIELD_ENCRYPTION_KEY", "32 bytes", "undefined", or a stack
    trace, and NO 500. (The OTP code itself won't arrive — that's expected, the Meta template is
    pending.)
6C. Open /account/login and try a DIFFERENT unregistered made-up number with any password. PASS if you
    get a single generic "Invalid phone or password." (it must NOT reveal whether the number exists).
6D. Open /account/reset , submit a made-up number. PASS if you get a neutral "If that number has an
    account, we sent a reset code." (must NOT confirm existence). No 500.

PART 7 — NOT TESTABLE IN A BROWSER (note only — do NOT attempt)
These run over the WhatsApp bot / pay flow and can't be driven here; they're verified by the test
suite + live backend tests instead:
- The verify-before-send gate blocking an unverified send + the bot replying with a real verify LINK
  (the 👉-with-no-link bug we fixed) — needs a live WhatsApp chat.
- The per-transaction OTP on the pay page — needs a bot-generated pay link + a delivered code.
- The full register → OTP → login completion — needs the (pending) Meta AUTHENTICATION template.

REPORT
Give me a table: check | PASS/FAIL | evidence. Then call out, in priority order, any FAILs —
especially any 500, any leftover "[PLACEHOLDER …]" on the landing page, any config-key leak on
register (6B), or a bare-username actor in the audit (5D). If everything passed, say so plainly.
```
