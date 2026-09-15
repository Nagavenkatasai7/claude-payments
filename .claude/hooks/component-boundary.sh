#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit) — ADVISORY. When the branch is scoped to a
# component (feat/<c>/…, fix/<c>/…, component/<c>) and the edited file belongs to
# a DIFFERENT component per .claude/hooks/components.json, inject a reminder to
# check callers and keep the contract updated. Never blocks.
set -u
input=$(cat 2>/dev/null || true)
fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$fp" ] && exit 0
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
map="$root/.claude/hooks/components.json"
[ -f "$map" ] || exit 0
branch="${GUARD_BRANCH_OVERRIDE:-$(git -C "$root" symbolic-ref --short -q HEAD 2>/dev/null || echo '')}"
bc=$(printf '%s' "$branch" | sed -nE 's#^(feat|fix|component)/([a-z0-9-]+)(/.*)?$#\2#p')
[ -z "$bc" ] && exit 0
rel="${fp#"$root"/}"
python3 - "$map" "$rel" "$bc" <<'PY'
import json, sys, fnmatch
mapf, rel, bc = sys.argv[1:4]
m = json.load(open(mapf)); comps = m["components"]
if bc not in comps: sys.exit(0)
def hit(p):
    if p.endswith("/"): return rel.startswith(p)
    if "*" in p: return fnmatch.fnmatch(rel, p)
    return rel == p
if any(hit(p) for p in m.get("shared", [])): sys.exit(0)
owner = next((c for c, spec in comps.items() if any(hit(p) for p in spec["paths"])), None)
if owner is None or owner == bc or owner in m.get("neverWarn", []): sys.exit(0)
msg = (f"component-boundary: `{rel}` belongs to **{owner}**, but this branch is scoped to **{bc}**. "
       f"Cross-component edit: confirm it is intended, grep every caller of what you changed, and update the "
       f"contract (types + tests) in this same PR. If the change is really {owner}'s, prefer a separate PR cut from component/{owner}.")
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": msg}}))
PY
exit 0
