# Release-gate integrity audit

Verify that main's branch protection is intact and every recent merge actually
landed with a green `ci` check — so a forgotten `strict=true` restore or an
`--admin` merge over a red/missing check can't hide. Stops after one bounded pass.

*Adapts the published **stale-safe batch release loop** (unpublished adaptation).*
**Authority:** read-only; restoring protection is a write → **approval-gated.**

### Why
Landing PRs here repeatedly weakens the gate: `gh api … required_status_checks
-F strict=false` → merge → `strict=true` (the #171/#172 batch), and `gh pr merge
--admin` on every merge. If the restore is skipped, protection stays weakened
silently; an `--admin` merge can land a red/missing `ci`; a stale-base merge can
combine two individually-green PRs that break together.

### Cycle
1. **Observe** — read main's protection (`gh api repos/Nagavenkatasai7/claude-payments/branches/main/protection`)
   and the merges since the last audit (fallback: the last ~10) with each head
   SHA's `ci` conclusion.
2. **Choose** — one drift item: protection weakened, or a merge without a green `ci`.
3. **Act** — protection weakened → restore `strict=true` **with approval**; a
   bypassed merge → surface it (reporting; fixing a landed merge is a human call).
4. **Verify** — protection reads back as expected; the report lists each merge's
   gate status with its SHA.
5. **Record** — the audited window + findings (the new "last audited" point).

### Terminal states
- **No-op** — protection intact + every merge in the window was green.
- **Success** — protection restored (approved) and/or findings reported.
- **Approval-required** — before any protection write.
- **Blocked** — a merge landed on a red/missing `ci` → surface for a human
  (revert / forward-fix); never reported as success.
- Cannot run forever: a single pass over a bounded window + one protection read.

### Prompt
> After a merge session or on demand, read main's branch protection
> (`gh api repos/Nagavenkatasai7/claude-payments/branches/main/protection`) and
> confirm strict required-checks is ON. For the merges since the last audit (or the
> last ~10), check each head SHA's `ci` check concluded success. Report drift:
> protection weakened, or a PR merged without a green `ci`. If protection is off, ask
> before restoring `strict=true`. If a merge bypassed a red/missing check, surface it
> for a human — do not report it as success. Protection intact + all green → clean
> no-op. One bounded pass.
