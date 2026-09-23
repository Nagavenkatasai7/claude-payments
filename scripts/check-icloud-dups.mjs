#!/usr/bin/env node
/**
 * Program-Fix 40 (build-08, ui-14, docs-09) — fail CI when a tracked path looks
 * like an iCloud Drive sync duplicate: a file "<name> <n>.<ext>" / "<name> <n>"
 * or a directory segment "<name> <n>". The repo lives in iCloud on the owner's
 * machine, and a committed duplicate breaks the build ("Duplicate identifier"
 * in .next/types) or ships a stale copy. PR #285 removed the last tracked ones;
 * this is the guard that stops the next.
 *
 *   node scripts/check-icloud-dups.mjs      (run by the `lint` job in ci.yml)
 *
 * The local counterpart is .claude/hooks/icloud-dup-sweep.sh (untracked copies).
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// A segment ending in " <digits>", optionally followed by one extension
// ("page 3.tsx", "about-poster 2.svg", "dir 2"). "v2.ts" has no space;
// "Section 10 notes.md" does not END in the number.
const DUP_SEGMENT = /^.+ [0-9]+(\.[^/.][^/]*)?$/;

/** @param {string} path a repo-relative path with forward slashes */
export function isIcloudDuplicate(path) {
  return path.split('/').some((seg) => DUP_SEGMENT.test(seg));
}

/** @param {string[]} paths */
export function findIcloudDuplicates(paths) {
  return paths.filter(isIcloudDuplicate);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // -z: NUL-separated, never quoted (non-ASCII paths stay intact).
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const dups = findIcloudDuplicates(out.split('\0').filter(Boolean));
  if (dups.length > 0) {
    console.error(`check-icloud-dups: ${dups.length} tracked iCloud duplicate path(s). Remove them with git rm (keep the real file):`);
    for (const d of dups) console.error(`  ${d}`);
    process.exit(1);
  }
  console.log('check-icloud-dups: no tracked iCloud duplicate paths.');
}
