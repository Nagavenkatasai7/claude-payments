---
name: sync-branches
description: Fast-forward every component/* branch on origin to origin/main after a merge (never force). Reports any component branch that diverged so its commits get PR'd instead of overwritten. User-invoked.
disable-model-invocation: true
---
# /sync-branches — keep the component anchors equal to main

The `component/<name>` branches (docs/COMPONENTS.md) are stable anchors you cut `feat/<component>/<slug>` branches from. They must never drift from main.

1. `git fetch -q origin`
2. `git branch -r --list 'origin/component/*' | sed 's#.*origin/##'` → the list.
3. One push, fast-forward only (no `--force`, ever):
   ```
   git push origin $(for b in <list>; do printf 'origin/main:refs/heads/%s ' "$b"; done)
   ```
4. Any `! [rejected] … (non-fast-forward)` line means someone committed directly on that component branch. For each: `git log --oneline origin/main..origin/component/<name>` and tell the user those commits need a PR to main (or a deliberate drop); do not resolve it by force.
5. Report: branches synced + the SHA they point at, and the rejected ones with their stray commits.
