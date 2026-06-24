# iCloud dup-file sweep

In one bounded pass, remove the stray `* 2.*` iCloud-sync duplicate files, confirm
the build still passes, then stop. Catches every duplicate extension — the current
`find … -name '* 2.ts'` guard misses `.tsx`, `.sql`, `.mjs`, which are exactly the
ones that slip through and trigger `Duplicate identifier` build breaks (e.g. the
`page 2.tsx` that forced cleanup PR #173, and the `0008_*_thrasher 2.sql` orphan).

**Authority:** local file deletion (tracked files go through a PR, so the diff is
reviewable; the build-green check proves the real file survived).

### Cycle
1. **Observe** — list duplicates in **one pass**: tracked
   `git ls-files | grep -E ' 2\.(ts|tsx|sql|js|mjs)$'` and untracked
   `find . -path ./node_modules -prune -o -name '* 2.*' -print`; also `rm -rf .next`.
2. **Act** — remove each (`git rm` if tracked). The broad `find '* 2.*'` pass is the
   catch-all (any extension); the tracked grep is just a fast subset for code files.
3. **Verify** — two checks, because the build only covers code:
   - **Code dups** (`.ts/.tsx/.js/.mjs`): `npm run build` once; it must stay green.
   - **Non-code dups** (`.json/.svg/…`): the build can't catch a wrong delete — confirm
     the **real counterpart** (same path without ` 2`) still exists and is tracked
     (`git ls-files --error-unmatch <real>`).
4. **Record** — which files were removed.

### Terminal states
- **No-op** — none found.
- **Success** — duplicates removed + build green.
- **Blocked** — build breaks after a removal ⇒ that file was the **real** one:
  restore it and stop.
- Cannot run forever: a **single pass**. If a removed duplicate reappears
  (iCloud re-sync), stop and surface it — do **not** sweep again in a loop.

### Prompt
> Trigger: before a gate/commit, or on demand. In ONE pass, list duplicates:
> `git ls-files | grep -E ' 2\.(ts|tsx|sql|js|mjs)$'` (tracked) and
> `find . -path ./node_modules -prune -o -name '* 2.*' -print` (untracked); also
> `rm -rf .next`. Remove each (`git rm` if tracked). Verify: for code dups run
> `npm run build` once (must stay green); for non-code dups (`.json/.svg/…`, which the
> build won't catch) confirm the real counterpart (path without ` 2`) still exists and
> is tracked. If a check fails, that file was the real one: restore it and stop. None
> found → clean no-op. Do not re-loop: if a removed duplicate reappears, stop and
> surface it rather than sweeping again.
