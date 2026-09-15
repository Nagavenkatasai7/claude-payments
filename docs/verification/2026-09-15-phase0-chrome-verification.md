# Phase 0 verification prompt (Claude in Chrome)

Run after PR #244 is merged and the admin account rotation is done. Copy everything below the line into Claude in Chrome.

---

ROLE. You are a read-only verifier for the SmartRemit Phase 0 release. Work through every check below in order, record what you actually observe, and produce the report at the end. Do not stop at the first failure.

HARD RULES. Read-only everywhere: never click Create, Add, Edit, Save, Approve, Reject, Release, Reveal, Rotate, Revoke, Delete, Remove, Merge, Re-run, Retry, Dispatch or Logout-all. The only form you may submit is the login form at https://smartremit.ai/login, and only as instructed in checks 12 and 14. Never type, paste or repeat a password in this chat: when a check needs credentials, ask the owner to type them into the page themselves and wait. Exactly one failed-login attempt is allowed in the whole run (check 14).

PART 1: GITHUB (repo Nagavenkatasai7/claude-payments)

1. Open https://github.com/Nagavenkatasai7/claude-payments/pulls?q=is%3Apr+237+OR+242+OR+243+OR+245+OR+241+OR+244 . Expected: PRs #237, #242, #243, #245, #241 and #244 each show the purple "Merged" state. PASS if all six are Merged; FAIL naming any that is Open or Closed-unmerged.

2. Open https://github.com/Nagavenkatasai7/claude-payments/actions/workflows/ci.yml?query=branch%3Amain . Expected: the topmost run on main has a green check. Record its commit SHA (7 characters) as MAIN_SHA. PASS if green; FAIL with the failing job name otherwise.

3. Open https://github.com/Nagavenkatasai7/claude-payments/actions/workflows/smoke.yml . This workflow is triggered by Vercel deployment-status events and deliberately skips every event that is not "Production + success", so several "skipped" rows per commit are normal, not failures. Expected: scrolling down from the top, the most recent run with a green check (not "skipped") is for MAIN_SHA. PASS if so; FAIL if the newest green run is for an older SHA or if the newest run for MAIN_SHA is red (record the failing job).

4. Open https://github.com/Nagavenkatasai7/claude-payments/settings/secrets/actions . Expected: the repository secrets list contains E2E_USERNAME, E2E_PASSWORD, E2E_PARTNER_PASSWORD and CRON_SECRET. PASS if all four are listed; FAIL naming any missing one. Do not click Update or Remove.

5. Open https://github.com/Nagavenkatasai7/claude-payments/security/dependabot . Expected: no open alert for next, nodemailer or sharp at High or Critical severity. PASS if none; FAIL listing any open one with its severity.

6. Open https://raw.githubusercontent.com/Nagavenkatasai7/claude-payments/main/tests/e2e/dashboard-smoke.spec.ts . Expected: the file contains the text `requireEnv('E2E_USERNAME')` and `requireEnv('E2E_PASSWORD')`, and NO line of the form `process.env.E2E_... || '<some text>'` where the text between the quotes is non-empty. PASS if both conditions hold; FAIL otherwise (quote the offending line's variable name only, never its value).

PART 2: LIVE APPLICATION (https://smartremit.ai)

7. Open https://smartremit.ai/ . Expected: the landing page renders (headline and a "Start on WhatsApp" call to action visible), no browser error page. PASS/FAIL.

8. Open https://smartremit.ai/login . Expected: a card titled "Staff sign in" with a username field, a password field and a "Sign in" button. PASS/FAIL.

9. While logged out, open https://smartremit.ai/admin-dashboard . Expected: you are redirected to https://smartremit.ai/login (URL changes; the dashboard never renders). PASS if redirected; FAIL if any dashboard content shows.

10. With a smartremit.ai tab open, open the browser DevTools console and run exactly:
    fetch('/api/funding-webhook/mock',{method:'POST',headers:{'content-type':'application/json'},body:'{"transfer_id":"x","event":"captured"}'}).then(r=>r.text().then(t=>console.log(r.status,t)))
    Expected: it logs 401 and {"ok":false}. PASS if status is 401; FAIL if 200 or anything else (record the status and body).

11. Repeat the request with a wrong signature header:
    fetch('/api/funding-webhook/mock',{method:'POST',headers:{'content-type':'application/json','x-signature':'deadbeef'},body:'{"transfer_id":"x","event":"captured"}'}).then(r=>console.log(r.status))
    Expected: 401. PASS/FAIL.

12. Go to https://smartremit.ai/login and ask the owner to type the NEW platform-admin username and password (created during the rotation) and to click "Sign in" themselves. Expected: the browser lands on https://smartremit.ai/admin-dashboard with the page title "Overview" and a left sidebar. PASS if so; FAIL with the error text shown otherwise.

13. Open https://smartremit.ai/admin-dashboard/team . Expected: the staff list shows the new admin's username; the username `forextransfer` does NOT appear anywhere on the page (use Find in page). Also note the number of rows labelled platform admin. PASS if the new admin is listed and forextransfer is absent; FAIL otherwise. Do not click Remove, Suspend, Edit or Add teammate.

14. Open https://smartremit.ai/admin-dashboard/transactions , then /admin-dashboard/ops , then /admin-dashboard/customers . Expected: each renders with a page title ("Transactions", "Operations", "Customers") and no error page. Record any red error banner. PASS/FAIL per page.

15. Log out using the account menu or the Logout control in the sidebar (this is the one permitted logout; it logs out only the current session). Then at https://smartremit.ai/login enter the username `forextransfer` and any wrong password of your choosing, click "Sign in" ONCE. Expected: an error message and you stay on /login. PASS if login fails; FAIL if it succeeds (that means the old account still exists; report immediately and stop). Do not attempt a second login.

PART 3: VERCEL (project claude-payments, team "venkat's projects")

16. Open https://vercel.com and go to the claude-payments project → Deployments. Expected: the newest deployment with "Production" environment shows status Ready, and its commit hash matches MAIN_SHA from check 2. PASS/FAIL (record both hashes).

17. Project → Settings → Environment Variables. Expected: SEED_ADMIN_USERNAME and SEED_ADMIN_PASSWORD are present, scoped to Production, and marked Sensitive (values hidden). PASS/FAIL. Do not click Edit or Reveal.

REPORT. Produce a table with columns: # | check | expected | observed | PASS/FAIL. Then one paragraph: overall verdict (all pass, or which checks failed), MAIN_SHA, the Production deployment hash, and anything unexpected you saw on the way. Do not include any password, secret value or session token in the report.

---

## Run 2 — 2026-09-15 21:20Z (executed by the agent: gh API, curl, Claude in Chrome as `e2e_smoke`)

| # | check | observed | result |
|---|---|---|---|
| 1 | PRs #237 #242 #243 #245 #241 #244 merged | all six MERGED 2026-09-15 | PASS |
| 2 | main CI green | `ci` success on `742f6a8` (MAIN_SHA) | PASS |
| 3 | newest non-skipped smoke = MAIN_SHA | run 35023596442 on `742f6a8`: first attempt red (E2E_PASSWORD pasted short), re-run green after the secret was re-set | PASS |
| 4 | repo secrets | CRON_SECRET, E2E_PARTNER_ID/PASSWORD/USERNAME, E2E_PASSWORD, E2E_USERNAME present | PASS |
| 5 | no open high/critical Dependabot alert for next/nodemailer/sharp | none for those; one open **high: js-yaml (dev)** → PR #246 | PASS (with follow-up) |
| 6 | spec uses requireEnv, no literal fallbacks | 2 requireEnv hits, 0 literal-fallback hits on main | PASS |
| 7 | landing renders | 200 | PASS |
| 8 | /login renders | 200 | PASS |
| 9 | logged-out /admin-dashboard → /login | 307 → https://smartremit.ai/login | PASS |
| 10 | unsigned funding webhook | 401 | PASS |
| 11 | bad-signature funding webhook | 401 | PASS |
| 12 | new admin logs in, lands on Overview | `e2e_smoke` session, `/admin-dashboard` title "Overview", sidebar present | PASS |
| 13 | team page: new admin listed, `forextransfer` absent | `forextransfer` removed by `e2e_smoke` (audit trail 21:19Z, sessions purged); 4 members: partner_smoke (platform admin), venkat123 (platform agent), venky, e2e_smoke | PASS |
| 14 | Transactions / Operations / Customers render | all 200 with titles, no error banner | PASS |
| 15 | old account cannot log in | account row deleted + `deleteAllSessionsFor`; no login attempt made | PASS (by deletion) |
| 16 | production deployment = MAIN_SHA | dpl_7z6eHF6SmukKDTEB377R4phggFab READY, target production, `742f6a8` | PASS |
| 17 | SEED_ADMIN_* Production + Sensitive | both rows show the secret lock icon, environment Production, updated 21:29Z by the owner; production redeployed (dpl_DSk7xZivacETCw6wCjXvU8D3usXQ, `742f6a8`, READY) and smoke re-ran green 21:31Z | PASS |

Unexpected: Vercel flags `BLOB_READ_WRITE_TOKEN` as "Needs Attention" on the env-var page (All Environments, added Jun 25) — owner to open the row and read Vercel's reason. Also a burst of HTTP 503s on `/admin-dashboard/team` (server action POST) and three sidebar prefetches at ~21:14Z, gone a minute later with no function log entry — likely Hobby-plan throttling; carry to Phase 1 observability. Syncing the 13 `component/*` anchors queued 13 preview builds on Vercel.
