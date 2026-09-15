---
name: worker-poke
description: Trigger one production outbox drain via the worker-heartbeat GitHub Actions workflow (which holds CRON_SECRET), wait for it, then run /outbox-status. User-invoked; touches prod only through the same path the 5-minute heartbeat uses.
disable-model-invocation: true
---
# /worker-poke — drain the prod outbox once

`/api/worker` requires `Bearer CRON_SECRET`, which exists only in Vercel + GitHub secrets. Use the heartbeat workflow as the authenticated caller. Never ask for, echo, or paste the secret.

1. Baseline: run /outbox-status (note pending / failed / dead counts).
2. Trigger: `gh workflow run worker-heartbeat.yml --ref main`
3. Wait: `sleep 8; gh run list --workflow=worker-heartbeat.yml --limit 1 --json databaseId,status,url` → `gh run watch <databaseId> --exit-status`.
4. A non-2xx from the worker FAILS the run (curl -f): `gh run view <databaseId> --log-failed` and report the HTTP code (401 = CRON_SECRET mismatch; 5xx = worker crashed — check `npx vercel logs`).
5. After: run /outbox-status again and report the delta. Remember: dead rows never auto-retry (admin-dashboard/ops Retry), stuck-paid re-instructs once per sweep, and the worker's time budget is 45 s per invocation, so a deep backlog needs several pokes or simply the next heartbeat.
