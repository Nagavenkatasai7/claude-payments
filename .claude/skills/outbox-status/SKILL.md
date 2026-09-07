---
name: outbox-status
description: Read-only snapshot of the durability outbox and stuck money on the prod ledger — rows by status/kind, due backlog, dead rows with their last error, stale processing locks, stuck paid >15m, stale reviews >24h, pending refunds. Use when asked whether anything is stuck, after a deploy, or when an ops alert fires.
---
# /outbox-status — is anything stuck?

```
set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/outbox-status.ts
```
SELECTs only. Thresholds are imported from `src/lib/reconcile.ts` (STUCK_PAID_MINUTES, STALE_REVIEW_HOURS, STUCK_REFUND_MINUTES), so the script and the sweep cannot disagree.

How to read it:
- **due backlog > 0 and oldest_due older than ~10 min** → the heartbeat may be failing: `gh run list --workflow=worker-heartbeat.yml --limit 3` (a failed run = non-2xx from /api/worker). Offer /worker-poke.
- **dead rows** → attempts exhausted (8). They never retry on their own; name kind + last_error and point to admin-dashboard/ops → Retry. A `whatsapp.send` dead row usually means a Meta token/template problem; `settlement.instruct` dead = the partner rail rejected the signed instruction.
- **stale processing locks (>5 min)** → a worker invocation died mid-row; the next drain reclaims them (SKIP LOCKED + lock age), report only.
- **stuck paid** → money left the customer but no delivery confirmation; reconcile re-instructs once and alerts the ops phone. Never "fix" the ledger by hand.
- **pending refunds with no recent funding.refund effect** → lost effect; ops decides (provider may be mid-incident).
Report counts first, then the specific rows that need a human.
