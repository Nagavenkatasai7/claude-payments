#!/usr/bin/env bash
# SessionStart — one-pass iCloud duplicate sweep (docs/loops/icloud-dup-file-sweep.md).
# iCloud Drive sync creates "<name> 2.<ext>" files / "<name> 2" dirs that break the
# build ("Duplicate identifier" in .next/types). Rules:
#   • UNTRACKED duplicate whose real counterpart exists  → deleted.
#   • duplicate with NO counterpart                       → left alone, reported (might be the real file).
#   • TRACKED duplicate                                    → reported only (git rm belongs in a PR).
#   • any duplicate under .next/                           → rm -rf .next (build cache).
# Skips node_modules, .git, .claude/worktrees. Single pass; never loops.
set -u
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$root" || exit 0
removed=(); kept=(); tracked=(); nextdirty=0
while IFS= read -r -d '' f; do
  [ -e "$f" ] || continue                       # parent dup already removed
  case "$f" in ./.next/*) nextdirty=1; continue ;; esac
  rel="${f#./}"
  if git ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then tracked+=("$rel"); continue; fi
  if [ -d "$f" ]; then
    real="${f% 2}"
  else
    base="${f##*/}"; dir="${f%/*}"
    if [[ "$base" == *" 2."* ]]; then real="$dir/${base/ 2./.}"; else real="${f% 2}"; fi
  fi
  if [ -e "$real" ]; then rm -rf -- "$f"; removed+=("$rel"); else kept+=("$rel"); fi
done < <(find . \( -path ./node_modules -o -path ./.git -o -path ./.claude/worktrees \) -prune -o \( -name '* 2.*' -o -name '* 2' \) -print0 2>/dev/null)
[ "$nextdirty" = 1 ] && rm -rf .next
out=""
[ ${#removed[@]} -gt 0 ] && out="${out}icloud-dup-sweep: removed ${#removed[@]} untracked iCloud duplicate(s): ${removed[*]}\n"
[ "$nextdirty" = 1 ]     && out="${out}icloud-dup-sweep: .next contained iCloud duplicates → removed .next (build cache, rebuilds on next dev/build)\n"
[ ${#kept[@]} -gt 0 ]    && out="${out}icloud-dup-sweep: LEFT ALONE (no real counterpart, may be the real file — inspect): ${kept[*]}\n"
[ ${#tracked[@]} -gt 0 ] && out="${out}icloud-dup-sweep: TRACKED duplicates need a PR (git rm): ${tracked[*]}\n"
[ -n "$out" ] && printf '%b' "$out"
exit 0
