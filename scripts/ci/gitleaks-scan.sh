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
# Baseline: .gitleaksignore at the repo root (commit-bound fingerprints of
# reviewed historical fixtures). A new test fixture that trips a rule gets an
# inline `gitleaks:allow` comment, reviewed in its PR; there is no path-wide
# allowlist.
set -euo pipefail

: "${GITLEAKS_BIN:?GITLEAKS_BIN is required}"
: "${SCAN_MODE:?SCAN_MODE is required (full|diff)}"

ZERO=0000000000000000000000000000000000000000

has_commit() { [ -n "${1:-}" ] && git cat-file -e "${1}^{commit}" 2>/dev/null; }

if [ "$SCAN_MODE" = full ]; then
  # HEAD history only. actions/checkout with fetch-depth: 0 also fetches every
  # remote branch; gitleaks' default log options (--all) would scan those too
  # and go red on whatever stale branch exists that night.
  log_opts="--full-history HEAD"
elif [ "$SCAN_MODE" = diff ]; then
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request)
      log_opts="${PR_BASE_SHA:?}..${PR_HEAD_SHA:?}"
      ;;
    merge_group)
      log_opts="${MG_BASE_SHA:?}..${MG_HEAD_SHA:?}"
      ;;
    push)
      : "${GITHUB_SHA:?}"
      if [ "${PUSH_BEFORE:-$ZERO}" = "$ZERO" ] || ! has_commit "${PUSH_BEFORE:-}"; then
        log_opts="-1 ${GITHUB_SHA}"
      else
        log_opts="${PUSH_BEFORE}..${GITHUB_SHA}"
      fi
      ;;
    *)
      echo "::error::gitleaks-scan: unsupported event '${GITHUB_EVENT_NAME:-}' for diff mode"
      exit 2
      ;;
  esac
else
  echo "::error::gitleaks-scan: SCAN_MODE must be full or diff (got '$SCAN_MODE')"
  exit 2
fi

echo "gitleaks log-opts: $log_opts"
"$GITLEAKS_BIN" git --redact --no-banner --verbose --exit-code 1 --log-opts="$log_opts" .
