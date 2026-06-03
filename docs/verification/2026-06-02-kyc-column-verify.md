# Claude-in-Chrome verification — KYC dashboard column (2026-06-02)

Quick visual check that the new KYC column renders on both dashboard tables. Paste into Claude-in-Chrome.

```
ROLE / MISSION
You are a QA tester checking a small UI addition on the SmartRemit admin dashboard at
https://claude-payments.vercel.app/admin-dashboard . A new "KYC" column was added to two tables.
Confirm it renders correctly. Record PASS/FAIL per step.

PREREQUISITES
- Confirm you're logged in (open /admin-dashboard → "Overview" with metric cards). If it redirects
  to /login, ask me to enter staff credentials, then continue. Don't enter credentials yourself.

STEPS
1. Open /admin-dashboard/customers . PASS if the table has a column headed "KYC" (between "Tier"
   and "Lifetime sent"), and each customer row shows a small colored status pill in it — one of
   "Verified" (green), "Grandfathered" (green), "Pending" / "Not started" (gray), or "Rejected"
   (red). FAIL if the KYC column is missing or the cells are blank/plain-text only.

2. Still on /admin-dashboard/customers, note whether any row additionally shows a blue "In review"
   badge and/or a red "Watchlist" / amber "PEP" badge next to its status pill. (These appear only
   for customers mid-Persona-review or with a sanctions/PEP hit — there may be none right now;
   that's fine. Just confirm that IF present they render as separate pills, not raw text.)

3. Open /admin-dashboard/transactions . PASS if the table has a "KYC" column (right after the
   "Tier" column) and each transaction row shows the sending customer's KYC status pill (same
   styles as step 1). A row whose sender has no customer record shows a neutral "—" pill — that's
   acceptable. FAIL if the KYC column is missing.

4. (Optional) Open a customer's detail page from the Customers list and confirm the "Identity &
   KYC" card still renders without error (the audit trail there now attributes a reviewer as
   "Name (username)" rather than a bare username, if any review has happened).

REPORT
Table: step | PASS/FAIL | evidence (what pill text/colors you saw). Call out any FAIL.
```
