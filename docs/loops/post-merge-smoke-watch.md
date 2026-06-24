# Post-merge smoke watch

After each merge to `main` (which auto-deploys prod), watch the `smoke.yml` run for
that commit and react to pass/fail — then stop. Makes the "verify the post-deploy
smoke went green after every merge" rule automatic, and turns a red smoke into an
immediate, specific report instead of a silent prod regression.

**Authority:** read-only (`gh` reads only).

### Cycle
1. **Observe** — a squash-merge landed on `main`; capture the merged SHA.
2. **Act (watch)** — poll `gh run list --workflow=smoke.yml --branch main` for that
   SHA until the run's status is `completed`. **Stop polling at completion.**
3. **Verify** — read the run's conclusion.
4. **Record** — the SHA + result.

### Terminal states
- **Success** — conclusion `success` → report green, done.
- **Blocked** — conclusion `failure` → fetch `gh run view --log-failed`, surface the
  specific failing job, and stop; do not stack more merges on top.
- **No-progress** — the deploy finished but **no smoke run is ever created** for the
  SHA → stop and report it didn't trigger.
- Cannot run forever: polling ends at the run's terminal state; the "never created"
  case is a no-progress stop, not an open-ended poll.

### Prompt
> Trigger: a squash-merge to main (auto-deploys prod). Poll
> `gh run list --workflow=smoke.yml --branch main` for the merged SHA until that
> run's status is `completed`, then stop polling. Success conclusion → report green,
> done. Failure → fetch `gh run view --log-failed`, surface the specific failure, and
> stop — do not merge anything else on top. If no smoke run is ever created for the
> SHA (no progress), stop and report it didn't trigger. Read-only: propose no fixes
> without asking. Watch one run per merge; never poll past completion.
