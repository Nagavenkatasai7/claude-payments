# Claude-in-Chrome verification — Phase 2 KYC admin review (2026-06-02)

Backend already verified live (a real Persona-signed `inquiry.created` webhook flipped a
customer to `inquiry_started`). This prompt verifies the **staff review UI** — the
human-review-only Approve gate — using a staged demo customer (`+1 555 000 9999`, in
`pending_review`). Paste the block into Claude-in-Chrome.

```
ROLE / MISSION
You are a QA tester driving a live admin dashboard in Chrome. You are verifying a just-shipped
"KYC review" feature for SmartRemit at https://claude-payments.vercel.app/admin-dashboard . A test
customer has been staged whose identity verification is awaiting a human decision. Your job: find
them in the review queue, confirm the KYC detail renders, and approve them — then confirm the
approval took effect. Record PASS/FAIL with a one-line note per step. ALL DATA IS TEST DATA.

PREREQUISITES
- Confirm you are logged into the admin dashboard (open /admin-dashboard; you should see an
  "Overview" page with metric cards). If it redirects to /login, ask me to enter the staff
  credentials, then continue. Do NOT enter or ask for credentials yourself otherwise.

STEPS
1. From the left sidebar, click "Compliance" (or open /admin-dashboard/compliance).
   PASS if the page renders and you see a card titled "Needs KYC review" near the top, with a
   subtitle like "1 customer — identity verification awaiting a human decision". FAIL on a 500
   or if the "Needs KYC review" card is absent.

2. In that "Needs KYC review" table, find the row for phone "+15550009999".
   PASS if the row shows: the phone, a State of "pending_review", and a Screening value of
   "Clear", plus a "Review" link/button. FAIL if the row is missing.

3. Click "Review" on that row (it opens /admin-dashboard/customers/15550009999).
   PASS if you land on the customer detail page and see an "Identity & KYC" card whose details
   include: Status "pending", Review state "pending_review", an Inquiry value starting "inq_",
   ID last 4 showing "••••6789", and Screening "Clear". FAIL on a 500 or if these fields are absent.

4. On that page, confirm there is a review panel that says Persona "passed — confirm to approve",
   with a REQUIRED reason text box and two buttons "Approve KYC" and "Reject KYC".
   PASS if present. Also note whether a "KYC audit trail" list is shown below it (it should show
   at least one entry from "persona").

5. (Negative check) Click "Approve KYC" WITHOUT typing a reason.
   PASS if the form refuses to submit / the page surfaces an error about a required reason (the
   reason is mandatory). FAIL if it submits with an empty reason.

6. Now type a reason like "Verified during live QA" in the reason box and click "Approve KYC".
   PASS if the page reloads and the customer is now Status "verified" / Review state "approved"
   (the review panel is gone), and a new audit entry appears (action "review.approve" with your
   reason). FAIL otherwise.

7. Go back to /admin-dashboard/compliance.
   PASS if "+15550009999" is NO LONGER in the "Needs KYC review" queue (approving removed it).
   FAIL if it's still listed.

REPORT
Give me a table: step | PASS/FAIL | evidence. Call out any FAIL. If all pass, say so plainly —
that confirms the human-review-only approve gate works end-to-end in the live UI.
```
