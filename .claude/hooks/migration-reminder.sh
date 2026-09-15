#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit) — prod drizzle migrations are MANUAL. Whenever a
# drizzle/*.sql file or src/db/schema.ts is written, inject the rule + the /migrate-prod
# path so the reminder lands at the moment the risk is created. Never blocks.
set -u
input=$(cat 2>/dev/null || true)
fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$fp" ] && exit 0
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
rel="${fp#"$root"/}"
msg=""
case "$rel" in
  drizzle/*.sql)
    msg="migration-reminder: \`$rel\` is a drizzle migration. Prod Neon migrations are MANUAL — nothing in CI/Vercel applies them; after this PR merges run /migrate-prod immediately (drizzle selects explicit column lists, so an unapplied migration breaks EVERY query on the altered table — the 2026-06-11 outage). Before merging: (1) the SQL must be additive (CREATE TABLE / ADD COLUMN / CREATE INDEX / ADD CONSTRAINT); any DROP / RENAME / column type change / backfill needs explicit human sign-off in the PR description; (2) drizzle/meta/_journal.json + snapshot must come from \`npx drizzle-kit generate\`, never hand-edited; (3) schema.ts and this SQL ship in the same PR." ;;
  src/db/schema.ts)
    msg="migration-reminder: src/db/schema.ts changed. Generate the matching migration (\`npx drizzle-kit generate\`) and commit the new drizzle/ SQL + meta in THIS PR, then run /migrate-prod right after merge. A schema.ts change without its migration ships code that selects columns prod does not have." ;;
esac
[ -z "$msg" ] && exit 0
jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
exit 0
