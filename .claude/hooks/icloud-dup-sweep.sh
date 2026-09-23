#!/usr/bin/env bash
# SessionStart — one-pass iCloud duplicate sweep (docs/loops/icloud-dup-file-sweep.md).
# iCloud Drive sync creates "<name> <n>.<ext>" files / "<name> <n>" dirs (n = 2, 3, …)
# that break the build ("Duplicate identifier" in .next/types). Rules:
#   • UNTRACKED duplicate whose real counterpart exists  → deleted.
#   • duplicate with NO counterpart                       → left alone, reported (might be the real file).
#   • TRACKED duplicate                                    → reported only (git rm belongs in a PR).
#   • any duplicate under .next/                           → rm -rf .next (build cache).
# Skips every node_modules* dir (incl. node_modules.nosync), .git, .claude/worktrees:
# nothing under node_modules* is ever removed; duplicates under node_modules.nosync
# are only COUNTED (purge = fix-40 owner step 7.2). Single pass; never loops.
# Bash 3.2 safe (macOS /bin/bash): regex in a variable, arrays guarded before use.
set -u
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$root" || exit 0
# "<stem> <digits>[.<ext>]": group 1 = stem, group 3 = extension with its dot.
# "page 3.tsx" → "page.tsx", "lib 2" → "lib", "a 2.test.ts" → "a.test.ts".
dup_re='^(.*) ([0-9]+)(\.[^/]*)?$'
removed=(); kept=(); tracked=(); nextdirty=0
while IFS= read -r -d '' f; do
  [ -e "$f" ] || continue                       # parent dup already removed
  base="${f##*/}"; dir="${f%/*}"
  [[ "$base" =~ $dup_re ]] || continue          # "v2.ts", "Section 10 notes.md": not a dup shape
  stem="${BASH_REMATCH[1]}"; ext="${BASH_REMATCH[3]}"
  [ -n "$stem" ] || continue
  case "$f" in ./.next/*) nextdirty=1; continue ;; esac
  case "$f" in */node_modules*) continue ;; esac   # belt and braces; find already prunes these
  rel="${f#./}"
  if git ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then tracked+=("$rel"); continue; fi
  real="$dir/${stem}${ext}"
  if [ "$real" != "$f" ] && [ -e "$real" ]; then rm -rf -- "$f"; removed+=("$rel"); else kept+=("$rel"); fi
done < <(find . \( -name 'node_modules*' -o -path ./.git -o -path ./.claude/worktrees \) -prune -o -name '* [0-9]*' -print0 2>/dev/null)
[ "$nextdirty" = 1 ] && rm -rf .next
# Count-only pass, never deletes: the iCloud copy of the deps (node_modules -> node_modules.nosync).
nm_dups=0
[ -d ./node_modules.nosync ] && nm_dups=$(find ./node_modules.nosync -maxdepth 2 -name '* [0-9]*' 2>/dev/null | wc -l | tr -d ' ')
out=""
[ ${#removed[@]} -gt 0 ] && out="${out}icloud-dup-sweep: removed ${#removed[@]} untracked iCloud duplicate(s): ${removed[*]}\n"
[ "$nextdirty" = 1 ]     && out="${out}icloud-dup-sweep: .next contained iCloud duplicates → removed .next (build cache, rebuilds on next dev/build)\n"
[ ${#kept[@]} -gt 0 ]    && out="${out}icloud-dup-sweep: LEFT ALONE (no real counterpart, may be the real file — inspect): ${kept[*]}\n"
[ ${#tracked[@]} -gt 0 ] && out="${out}icloud-dup-sweep: TRACKED duplicates need a PR (git rm): ${tracked[*]}\n"
[ "${nm_dups:-0}" -gt 0 ] && out="${out}icloud-dup-sweep: ${nm_dups} duplicates under node_modules.nosync — see fix-40 owner step 7.2 (keep the node_modules symlink)\n"
[ -n "$out" ] && printf '%b' "$out"
exit 0
