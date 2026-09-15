#!/usr/bin/env bash
# PreToolUse(Bash) guard — enforces CLAUDE.md "No direct pushes to main".
# Denies: any `git push` whose refspec targets main (incl. force / HEAD:main /
# refs/heads/main / :main delete / +main); any `git push` or `git commit` while
# the checked-out branch IS main. Everything else passes through (no output).
# Each shell segment (split on && || ; |) is judged on its own, so
# `git branch -f x origin/main && git push origin x` is NOT a false positive.
# Tests: scratchpad hook-tests.sh (GUARD_BRANCH_OVERRIDE simulates the branch).
set -u
input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0
case "$cmd" in *git*) ;; *) exit 0 ;; esac

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
branch="${GUARD_BRANCH_OVERRIDE:-$(git -C "$root" symbolic-ref --short -q HEAD 2>/dev/null || echo '')}"

# "git [global opts] <verb>" at the start of a segment; a main-target token anywhere in it.
GIT_RE='(^|[;&|[:space:]])git[[:space:]]+([-[:alnum:]=/._~]+[[:space:]]+)*'
MAIN_RE='(^|[[:space:]:/+])main([[:space:]]|$)'
segs=$(printf '%s\n' "$cmd" | sed -E 's/(&&|\|\||;|\|)/\n/g')
while IFS= read -r seg; do
  [ -z "$seg" ] && continue
  if printf '%s' "$seg" | grep -Eq "${GIT_RE}push([[:space:]]|\$)"; then
    if printf '%s' "$seg" | grep -Eq "$MAIN_RE"; then
      deny "Blocked by .claude/hooks/guard-git-main.sh: this push targets main. CLAUDE.md forbids direct pushes to main — push a feature branch and open a PR (gh pr create); main only moves via merged PRs after the ci check."
    fi
    if [ "$branch" = "main" ]; then
      deny "Blocked by .claude/hooks/guard-git-main.sh: you are on main. Create a branch first (git checkout -b feat/<component>/<slug>) and push that."
    fi
  fi
  if [ "$branch" = "main" ] && printf '%s' "$seg" | grep -Eq "${GIT_RE}commit([[:space:]]|\$)"; then
    deny "Blocked by .claude/hooks/guard-git-main.sh: committing on main. Create a branch first (git checkout -b feat/<component>/<slug>) — main only moves via merged PRs."
  fi
done <<< "$segs"
exit 0
