# Claude-in-Chrome prompt — SmartRemit AI Copilots, detailed test pass

> Paste everything below the line into Claude-in-Chrome. It drives your browser through all six new AI copilot features on the live site and verifies the one rule that matters most: **the AI only suggests — it must never move money or auto-execute.**

---

You are a meticulous QA tester driving a real browser. You are testing **6 new AI "copilot" features** on the live SmartRemit admin dashboard at **https://smartremit.ai**. These are *rung‑1* copilots: the AI **only suggests / narrates** — it must **NEVER** move money, change a transfer's status, approve KYC, or execute any action on its own. A human (or deterministic code) still performs every real action. Your single most important job, for every feature, is to confirm that getting an AI suggestion **changes nothing** until a human clicks a real button.

## Ground rules
1. **Log in first.** Go to `https://smartremit.ai/login` and sign in with my **platform‑admin** account (admin role, *no* partner scope). Confirm you land on `/admin-dashboard`. If a login form needs credentials I haven't provided, pause and ask me.
2. **AI calls are live and slow.** After clicking any AI button you'll see a loading label — **`Analyzing…`**, **`Diagnosing…`**, or **`Thinking…`**. **Wait up to ~30 seconds** for it to resolve before asserting anything. If you instead see **`AI unavailable`**, that is the intended graceful‑degradation state (the model timed out) — note it, retry once, and move on; do **not** mark the feature broken for this.
3. **Data‑dependent panels.** Several AI affordances only appear when there is relevant data (a customer in KYC review, transfers in review, stuck/dead rows, corridor leads, a non‑healthy partner). If a feature has no data to act on, **confirm the page renders cleanly, screenshot it, write "no data to exercise," and continue.** Never fail a feature for lack of data.
4. **Screenshot every step** — before the action, the loading state, and the result.
5. **The suggest‑only check (do this for every feature):** after an AI suggestion appears, confirm (a) no transfer/customer/ticket status changed, (b) the real human action button is still present and still required, and (c) the AI panel shows only text/badges, **no button that executes anything**.

---

## Feature 1 — KYC review‑decision copilot
- **Where:** `/admin-dashboard/customers` → open a customer whose KYC is **in review** (look for a "needs review"/"in review" state). The copilot only renders for an admin viewing an in‑review case.
- **Do:** In the KYC Review section (below the decision textarea + Approve/Reject buttons), click the button labeled **`✦ AI review summary`**. Wait for `Analyzing…` to resolve.
- **Verify the result shows:** a line **`Suggests: Approve`** (or `Reject` / `Need more info`); a line **`Confidence: low|medium|high`**; a short narrative summary; and a bulleted **list of reasons**.
- **Suggest‑only check:** confirm the AI did **not** approve/reject anything — the **Approve KYC / Reject KYC** buttons are still there and still require you to type a reason and click. The customer's KYC status is unchanged.
- If no in‑review customer exists: note it; the panel is correctly hidden.

## Feature 2 — Auto‑triage of support tickets (automatic, no button)
- **Where:** `/admin-dashboard/tickets` (the queue table). The relevant column header is **`Category`** (4th column, after Priority).
- **Do (to generate a fresh ticket):** in a separate tab, open the customer portal `https://smartremit.ai/account/support/new`, sign in as a customer (or use an existing customer session), and submit a new support ticket with a clear subject like *"My refund hasn't arrived"*. Submit it.
- **Verify:** return to `/admin-dashboard/tickets`, refresh after **~30–60 seconds** (triage runs asynchronously via a background worker). The new ticket's **Category** cell should change from `—` to a sensible value (e.g. `refund`), and Priority may update too.
- **Suggest‑only / safety check:** this one auto‑applies a *category/priority* only (never money/compliance). Confirm the triage is plausible for the subject; if the worker hasn't run yet, the cell shows `—` (acceptable — it's eventually‑consistent, retried, and a human can still triage manually).

## Feature 3 — Corridor‑demand launch recommender (platform admin only)
- **Where:** `/admin-dashboard/corridors`.
- **Verify the table:** a **`Ranked destinations`** table with columns **`#`, `Destination`, `Leads`, `Senders`, `Trend (7d vs prior)`, `USD demand`, `Status`**. Confirm it's sorted by demand (highest first).
- **Verify the AI brief:** above the table, a card titled **`Launch recommendation`** with the description *"AI‑generated from the ranked demand below."* and a short prose brief. (If there are zero corridor leads, this card is correctly hidden — note it.)
- **To generate a lead first (optional):** message the WhatsApp bot asking to send to an **unsupported** country (e.g. "send to Nigeria"); the bot captures it as a corridor request, which then appears here.
- **Access check (optional):** log in as a **partner‑scoped** staffer and confirm `/admin-dashboard/corridors` redirects away (platform‑only).

## Feature 4 — Partner health & stall scoring
- **Where:** `/admin-dashboard/partners` → open any partner (e.g. **Acme Remit**) → **Overview** tab.
- **Verify:** a card titled **`Integration health`** with a badge reading **`Healthy` / `Watch` / `At risk` / `Stalled`**, and a description *"Deterministic churn‑risk read from this partner's activity, rate feed, and queue."* Below it, a **signals** list (or *"No risk signals…"*).
- **Verify the AI narration:** when the band is **not** `Healthy`, an inset block **`Suggested outreach (AI)`** appears with a 2–3 line "why at risk + what to do." (If every partner is healthy, the narration is correctly omitted — note it.) Open 2–3 partners to find varied bands.
- **Suggest‑only check:** nothing here executes — it's read‑only context.

## Feature 5 — Stuck‑transfer & dead‑letter diagnosis
- **Where:** `/admin-dashboard/ops`.
- **Do:** on the **Dead letters** table and/or the **Stuck in paid** table, find a row and click **`✦ Diagnose`** (right column). Wait for `Diagnosing…` to resolve.
- **Verify the result shows:** three badges — **`failure_class`**, **`suggested_action`**, and a **`blast_radius`** badge (`isolated` / `cluster` / `systemic`) — plus a **rationale** paragraph.
- **Suggest‑only check:** confirm the existing **Retry / Dismiss** buttons are unchanged and the AI did not retry/dismiss anything itself. The row's state is unchanged until you click a real button.
- If both tables are empty (healthy system): note "no stuck/dead rows to diagnose" — that's a good sign, not a failure.

## Feature 6 — Stale‑review router (compliance)
- **Where:** `/admin-dashboard/compliance` → the **Needs review** (in‑review) table.
- **Do:** on an in‑review transfer row, in the Actions column (below the **Release** / **Reject & refund** buttons), click **`✦ Suggest disposition`**. Wait for `Thinking…` to resolve.
- **Verify the result shows:** an **urgency** badge (`low|normal|high urgency`), a **`suggested_path`** badge (`release` / `hold` / `escalate`), the caption **`AI suggestion — you decide`**, and a **rationale** paragraph.
- **Suggest‑only check (most important here — this is money):** confirm the AI did **NOT** release or reject the transfer. The **Release** and **Reject & refund** buttons are still present and still require your click. The transfer is still in review.
- If there are no in‑review transfers: note it; the affordance is correctly absent.

---

## Cross‑cutting checks (run across all six)
- **Suggest‑only invariant:** for each feature, explicitly confirm no money moved, no status changed, no KYC decision was made — the AI output is text/badges only, and every real action still needs a human click. Flag loudly if any AI panel contains a button that executes an action.
- **Graceful degradation:** where you saw `AI unavailable`, confirm the page itself still worked (the deterministic data/table/buttons rendered fine).
- **No sensitive data in AI output:** confirm AI text shows only masked details (e.g. `****1234` for accounts), never a full payout destination or full PII.
- **Tenant isolation (optional):** as a partner‑scoped staffer, confirm you can't see other partners' data and that Corridors is blocked.

## Deliverable
Produce a results table:

| # | Feature | Tested? | AI suggestion rendered? | Suggest‑only verified? | Screenshot ref | Notes / bugs |
|---|---------|--------|------------------------|------------------------|----------------|--------------|

Then a short summary: how many features fully passed, any that couldn't be exercised (and why — usually "no data"), and a clearly‑written reproduction for any bug you found. Attach all screenshots.
