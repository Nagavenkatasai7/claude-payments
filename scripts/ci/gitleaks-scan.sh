#!/usr/bin/env bash
# Compliance A3: the ONE gitleaks entry point for CI (ci.yml `security`, diff
# mode) and the nightly (nightly.yml `secret-scan`, full mode). A found secret
# exits 1 and fails the job. Output is always --redact: this repo is public and
# job logs are readable by anyone.
#
# Env:
#   GITLEAKS_BIN   path to the pinned, sha256-verified gitleaks binary
#   SCAN_MODE      full | diff
#   diff mode, per GITHUB_EVENT_NAME:
#     pull_request  PR_BASE_SHA..PR_HEAD_SHA (the PR's own commits)
#     merge_group   MG_BASE_SHA..MG_HEAD_SHA
#     push          PUSH_BEFORE..GITHUB_SHA; a new ref (all-zeros before) or a
#                   before that is not in the clone (force-push) falls back to
#                   the pushed commit alone
#
# Fail-closed: a shallow clone, a range end missing from the clone, an empty
# diff range or a missing config exits 2 (never a silent "0 commits scanned").
#
# Baseline: .gitleaksignore at the repo root (commit-bound fingerprints of
# reviewed historical fixtures) and .gitleaks.toml (default rules plus
# value-exact allowlists, passed explicitly). A new test fixture that trips a
# rule gets an inline `gitleaks:allow` comment, reviewed in its PR; there is
# no path-wide allowlist.
set -euo pipefail

: "${GITLEAKS_BIN:?GITLEAKS_BIN is required}"
: "${SCAN_MODE:?SCAN_MODE is required (full|diff)}"

ZERO=0000000000000000000000000000000000000000
CONFIG=.gitleaks.toml

fail() {
  echo "::error::gitleaks-scan: $1"
  exit 2
}

has_commit() { [ -n "${1:-}" ] && git cat-file -e "${1}^{commit}" 2>/dev/null; }

# Both ends must be in the clone and the range must hold at least one commit.
diff_range() {
  has_commit "$1" || fail "range base $1 is not in the clone"
  has_commit "$2" || fail "range head $2 is not in the clone"
  [ "$(git rev-list --count "$1..$2")" -gt 0 ] || fail "range $1..$2 holds no commits"
  log_opts="$1..$2"
}

[ "$(git rev-parse --is-shallow-repository)" = false ] || fail "shallow clone; check out with fetch-depth: 0"
[ -f "$CONFIG" ] || fail "$CONFIG not found in $(pwd)"

if [ "$SCAN_MODE" = full ]; then
  # HEAD history only. actions/checkout with fetch-depth: 0 also fetches every
  # remote branch; gitleaks' default log options (--all) would scan those too
  # and go red on whatever stale branch exists that night.
  log_opts="--full-history HEAD"
elif [ "$SCAN_MODE" = diff ]; then
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request)
      diff_range "${PR_BASE_SHA:-}" "${PR_HEAD_SHA:-}"
      ;;
    merge_group)
      diff_range "${MG_BASE_SHA:-}" "${MG_HEAD_SHA:-}"
      ;;
    push)
      has_commit "${GITHUB_SHA:-}" || fail "pushed commit ${GITHUB_SHA:-} is not in the clone"
      # New ref or unknown before: the pushed commit alone. main blocks
      # force-push, and the nightly full-history scan covers any gap.
      if [ "${PUSH_BEFORE:-$ZERO}" = "$ZERO" ] || ! has_commit "${PUSH_BEFORE:-}"; then
        log_opts="-1 ${GITHUB_SHA}"
      else
        diff_range "$PUSH_BEFORE" "$GITHUB_SHA"
      fi
      ;;
    *)
      fail "unsupported event '${GITHUB_EVENT_NAME:-}' for diff mode"
      ;;
  esac
else
  fail "SCAN_MODE must be full or diff (got '$SCAN_MODE')"
fi

echo "gitleaks log-opts: $log_opts"
"$GITLEAKS_BIN" git --redact --no-banner --verbose --exit-code 1 --config "$CONFIG" --log-opts="$log_opts" .
