# Flaky-test stabilizer

Turn a masked flake into a fixed test: reproduce the nondeterminism, fix it (without
weakening assertions), and prove it with a consecutive-pass streak. Stops when the
streak holds or the flake can't be reproduced.

*Adapts the published **test stabilizer loop** (unpublished adaptation).*
**Authority:** edits tests → **PR**.

### Why
Flakes recur and are currently *masked*: vitest has a CI-only retry, `nightly.yml`'s
comment names "flake accumulation," and CLAUDE.md warns "occasional parallel-run
flakes pass in isolation" + the `freshDb()`-before-`vi.useFakeTimers()` ordering trap.
The retry hides nondeterminism instead of fixing it.

### Cycle
1. **Observe** — a test that failed in CI/nightly but passes in isolation.
2. **Choose** — that one flaky test.
3. **Act** — reproduce under the suite's real parallelism (bounded attempts),
   root-cause (shared state, timer order, time-window fixture), apply one fix.
4. **Verify** — run the repaired file a fixed **consecutive streak** (e.g. 10×) with
   zero failures, assertions intact.
5. **Record** — test, root cause, fix.
6. **Repeat or stop** — next flaky test.

### Terminal states
- **No-op** — no flaky test in scope.
- **Success** — the streak holds with assertions intact → PR the fix.
- **No-progress** — can't reproduce after the attempt budget → report "couldn't
  reproduce" (explicitly **not** success); do not loop.
- Cannot run forever: bounded reproduction attempts + a finite consecutive-pass
  streak as the gate; one test per pass.
- **Guard against gaming:** a fix that skips the test or deletes assertions is
  forbidden — the streak must pass the full test, or it's not success.

### Prompt
> When a test fails in CI or nightly but passes in isolation, reproduce it by running
> that file repeatedly under the suite's real parallelism (bounded attempts).
> Root-cause the nondeterminism and fix the test or its setup — do not skip it or
> delete assertions. Verify by running the repaired file a fixed consecutive streak
> (e.g. 10×) with zero failures. Stop when the streak holds (success), or report
> "couldn't reproduce" after the attempt budget — that is not success. One test per
> pass; PR the fix.
