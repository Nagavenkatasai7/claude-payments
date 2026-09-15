#!/usr/bin/env bash
# Stop hook — proof-of-work gate (CLAUDE.md "Ground truth & proof").
# If the working tree has uncommitted changes under src/ tests/ scripts/ drizzle/,
# run in parallel: tsc --noEmit · eslint on the changed files · vitest --changed,
# and refuse to stop (decision:block) until they pass. The same tree is verified
# at most once (stamp), a tree that already failed is reported once (failed stamp),
# and stop_hook_active short-circuits the loop Claude Code itself guards against.
# Env: VERIFY_VITEST_BUDGET_S (default 420) caps the vitest leg.
set -u
input=$(cat 2>/dev/null || true)
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)" = "true" ] && exit 0
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$root" || exit 0
[ -x node_modules/.bin/tsc ] || exit 0

changed=$( { git diff --name-only HEAD -- . ; git ls-files --others --exclude-standard ; } 2>/dev/null \
  | sort -u | grep -E '^(src|tests|scripts|drizzle)/.*\.(ts|tsx|mts|cts|js|mjs|sql)$' || true)
[ -z "$changed" ] && exit 0

stamp=$( { git diff HEAD -- src tests scripts drizzle
           git ls-files --others --exclude-standard -z -- src tests scripts drizzle \
             | while IFS= read -r -d '' f; do printf '%s\n' "$f"; cat "$f"; done
         } 2>/dev/null | shasum | cut -c1-16)
okstamp=".claude/.verify-stamp"; badstamp=".claude/.verify-stamp-failed"
[ -f "$okstamp" ]  && [ "$(cat "$okstamp"  2>/dev/null)" = "$stamp" ] && exit 0
[ -f "$badstamp" ] && [ "$(cat "$badstamp" 2>/dev/null)" = "$stamp" ] && { echo "verify-on-stop: tree unchanged since the last FAILED verify — not re-running."; exit 0; }

tmp=$(mktemp -d); start=$(date +%s)
existing_ts=$(printf '%s\n' "$changed" | grep -E '\.(ts|tsx|mts|cts|js|mjs)$' | grep -vE '^drizzle/' \
  | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done)

( node_modules/.bin/tsc --noEmit >"$tmp/tsc.log" 2>&1 </dev/null; echo $? >"$tmp/tsc.rc" ) >/dev/null 2>&1 </dev/null &
if [ -n "$existing_ts" ]; then
  ( printf '%s\n' "$existing_ts" | tr '\n' '\0' | xargs -0 node_modules/.bin/eslint --max-warnings 0 >"$tmp/eslint.log" 2>&1 </dev/null; echo $? >"$tmp/eslint.rc" ) >/dev/null 2>&1 </dev/null &
else
  echo 0 >"$tmp/eslint.rc"; : >"$tmp/eslint.log"
fi
(
  # vitest with a wall-clock budget. No orphaned `sleep`: it is killed explicitly,
  # and every background job has its stdio detached so the caller sees EOF the
  # moment this script exits (an inherited stdout pipe made earlier runs hang).
  node_modules/.bin/vitest run --changed --passWithNoTests --reporter=dot >"$tmp/vitest.log" 2>&1 </dev/null &
  vpid=$!
  sleep "${VERIFY_VITEST_BUDGET_S:-420}" >/dev/null 2>&1 </dev/null &
  spid=$!
  while kill -0 "$vpid" 2>/dev/null && kill -0 "$spid" 2>/dev/null; do sleep 1; done
  if kill -0 "$vpid" 2>/dev/null; then
    kill "$vpid" 2>/dev/null; sleep 1; kill -9 "$vpid" 2>/dev/null
    echo "vitest KILLED after ${VERIFY_VITEST_BUDGET_S:-420}s budget — run it manually" >>"$tmp/vitest.log"
  fi
  kill "$spid" 2>/dev/null
  wait "$vpid" 2>/dev/null; rc=$?
  echo "$rc" >"$tmp/vitest.rc"
) >/dev/null 2>&1 </dev/null &
wait

rc_tsc=$(cat "$tmp/tsc.rc"); rc_es=$(cat "$tmp/eslint.rc"); rc_vt=$(cat "$tmp/vitest.rc")
elapsed=$(( $(date +%s) - start ))
if [ "$rc_tsc" = 0 ] && [ "$rc_es" = 0 ] && [ "$rc_vt" = 0 ]; then
  echo "$stamp" >"$okstamp"; rm -f "$badstamp"
  echo "verify-on-stop: typecheck ✓ lint ✓ vitest --changed ✓ (${elapsed}s)"
  rm -rf "$tmp"; exit 0
fi
echo "$stamp" >"$badstamp"
reason="verify-on-stop FAILED (${elapsed}s): the working tree has UNVERIFIED changes. Fix the failures below, then stop again. If you are deliberately handing back a failing tree, say so explicitly and why."
[ "$rc_tsc" != 0 ] && reason="$reason
--- tsc --noEmit (rc=$rc_tsc) ---
$(grep -E 'error TS' "$tmp/tsc.log" | head -40)"
[ "$rc_es" != 0 ] && reason="$reason
--- eslint --max-warnings 0 (rc=$rc_es) ---
$(tail -40 "$tmp/eslint.log")"
[ "$rc_vt" != 0 ] && reason="$reason
--- vitest run --changed (rc=$rc_vt) ---
$(grep -vE '^[[:space:]]*$' "$tmp/vitest.log" | tail -60)"
jq -n --arg r "$reason" '{decision:"block",reason:$r}'
rm -rf "$tmp"; exit 0
