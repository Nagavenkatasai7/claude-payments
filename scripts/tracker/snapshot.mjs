#!/usr/bin/env node
// Program Ledger snapshot: reads GitHub (via the gh CLI) and the ledger's current `prs` and
// `fixes` documents, and writes the documents /tracker-sync should send to the ledger database.
//
// Usage: node scripts/tracker/snapshot.mjs --db <dir> --out <dir>
//   --db   directory produced by ArtifactData list with out_dir (expects <db>/prs/*.json and <db>/fixes/*.json)
//   --versions  optional JSON map {"prs/pr-237": 3, "meta/state": 5, ...} of current document versions
//          (from the ArtifactData list/get results); required to overwrite existing docs, which the db pins
//   --out  where to write meta__state.json, prs__pr-N.json, events__*.json, fix-proposals.json and batch-N.json
//
// Read-only against GitHub. It never marks a fix "done": a merged PR only proposes "merged";
// promotion to "done" needs verification evidence and is decided by the session running /tracker-sync.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const REPO = 'Nagavenkatasai7/claude-payments';
const FIRST_PROGRAM_PR = 237;
// PRs merged before the `Program-Fix:` convention existed.
const LEGACY_FIX_MAP = { 242: [1], 243: [3], 244: [2], 246: [3], 247: [2], 248: [2] };

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const DB = arg('--db'); const OUT = arg('--out'); const VERSIONS = arg('--versions') ? JSON.parse(readFileSync(arg('--versions'), 'utf8')) : {};
if (!DB || !OUT) { console.error('usage: snapshot.mjs --db <dir> --out <dir>'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const gh = (...a) => JSON.parse(execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const readDir = (d) => existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(d, f), 'utf8'))) : [];
const unwrap = (d) => (d && typeof d === 'object' && d.data && typeof d.data === 'object' ? d.data : d);

git('fetch', '-q', 'origin', 'main');
const mainSha = git('rev-parse', '--short=7', 'origin/main');
const ci = gh('run', 'list', '-R', REPO, '--workflow', 'ci.yml', '--branch', 'main', '--limit', '5', '--json', 'conclusion,status,headSha');
const ciMain = ci.find((r) => r.headSha.startsWith(mainSha));
const smoke = gh('run', 'list', '-R', REPO, '--workflow', 'smoke.yml', '--limit', '30', '--json', 'conclusion,status,headSha,url,createdAt')
  .filter((r) => r.conclusion !== 'skipped');
const smokeMain = smoke.find((r) => r.headSha.startsWith(mainSha));
const smokeLatest = smoke[0];

const prsGh = gh('pr', 'list', '-R', REPO, '--state', 'all', '--limit', '200', '--search', 'created:>=2026-09-07',
  '--json', 'number,title,state,mergedAt,mergeCommit,body,url,headRefName')
  // Program PRs only: Dependabot and the old overnight loop branches are not program work.
  .filter((p) => p.number >= FIRST_PROGRAM_PR && !/^(dependabot|loop)\//.test(p.headRefName));
const known = new Map(readDir(join(DB, 'prs')).map(unwrap).map((p) => [p.number, p]));
const fixesDb = new Map(readDir(join(DB, 'fixes')).map(unwrap).map((f) => [f.fix, f]));

const writes = []; const events = [];
const put = (collection, docId, body) => {
  const file = join(OUT, `${collection}__${docId}.json`);
  writeFileSync(file, JSON.stringify(body));
  const v = VERSIONS[`${collection}/${docId}`];
  writes.push({ op: 'set', collection, doc_id: docId, file_path: file, ...(v ? { if_version: v } : {}) });
};
const now = new Date().toISOString();
const proposals = new Map();

for (const p of prsGh.sort((a, b) => a.number - b.number)) {
  const trailer = [...(p.body || '').matchAll(/^Program-Fix:\s*([\d,\s]+)$/gim)].flatMap((m) => m[1].split(/[,\s]+/).filter(Boolean).map(Number));
  const fixes = [...new Set([...(LEGACY_FIX_MAP[p.number] || []), ...trailer])];
  const state = p.state === 'MERGED' ? 'merged' : p.state === 'OPEN' ? 'open' : 'closed';
  const mergeSha = p.mergeCommit?.oid?.slice(0, 7) ?? null;
  const body = { number: p.number, title: p.title, state, mergeSha, mergedAt: p.mergedAt || null, fix: fixes.length === 1 ? fixes[0] : fixes.length ? fixes : null, url: p.url };
  const prev = known.get(p.number);
  if (!prev || prev.state !== state || prev.mergeSha !== mergeSha || prev.title !== p.title || JSON.stringify(prev.fix) !== JSON.stringify(body.fix)) put('prs', `pr-${p.number}`, body);
  if (state === 'merged' && prev?.state !== 'merged') {
    events.push({ at: p.mergedAt, kind: 'merge', actor: 'github', title: `PR #${p.number} merged`, detail: `${p.title}${fixes.length ? ` (fix ${fixes.join(', ')})` : ''}; ${mergeSha}.`, refs: { pr: [p.number], fix: fixes, sha: mergeSha }, result: 'ok' });
  }
  if (state === 'open' && !prev) events.push({ at: now, kind: 'pr', actor: 'github', title: `PR #${p.number} opened`, detail: p.title, refs: { pr: [p.number], fix: fixes } });
  if (state === 'merged') for (const f of fixes) {
    const cur = proposals.get(f) || { fix: f, prs: [], lastMergeSha: null, lastMergedAt: null };
    cur.prs.push(p.number); if (!cur.lastMergedAt || p.mergedAt > cur.lastMergedAt) { cur.lastMergedAt = p.mergedAt; cur.lastMergeSha = mergeSha; }
    proposals.set(f, cur);
  }
}

const fixProposals = [...proposals.values()].map((p) => {
  const cur = fixesDb.get(p.fix) || {};
  const prs = [...new Set([...(cur.prs || []), ...p.prs])].sort((a, b) => a - b);
  const proposedStatus = cur.status === 'done' ? 'done' : 'merged';
  return { fix: p.fix, title: cur.title, currentStatus: cur.status ?? null, proposedStatus, prs, mergeSha: p.lastMergeSha, needsVerification: proposedStatus !== 'done', changed: proposedStatus !== cur.status || JSON.stringify(prs) !== JSON.stringify(cur.prs || []) };
}).filter((p) => p.changed);
writeFileSync(join(OUT, 'fix-proposals.json'), JSON.stringify(fixProposals, null, 1));

// Production deploy status for the main SHA, from GitHub's deployment records (Vercel posts them).
function prodDeployState() {
  try {
    const sha = git('rev-parse', 'origin/main');
    const deps = gh('api', `repos/${REPO}/deployments?sha=${sha}&environment=Production&per_page=1`);
    if (!deps.length) return `${mainSha}: no production deployment recorded yet`;
    const st = gh('api', `repos/${REPO}/deployments/${deps[0].id}/statuses?per_page=1`);
    const state = st[0]?.state ?? 'pending';
    return `${mainSha}: production deploy ${state === 'success' ? 'READY' : state}`;
  } catch {
    return `${mainSha}: production deploy status unavailable`;
  }
}

const statePath = join(DB, 'meta', 'state.json');
const prevState = existsSync(statePath) ? unwrap(JSON.parse(readFileSync(statePath, 'utf8'))) : null;
if (smokeMain && prevState && prevState.smokeMain !== smokeMain.conclusion && smokeMain.conclusion) {
  events.push({ at: smokeMain.createdAt, kind: smokeMain.conclusion === 'success' ? 'verify' : 'incident', actor: 'ci', title: `Post-deploy smoke ${smokeMain.conclusion} on ${mainSha}`, detail: smokeMain.url, refs: { sha: mainSha }, result: smokeMain.conclusion === 'success' ? 'ok' : 'failed' });
}
put('meta', 'state', {
  mainSha, ciMain: ciMain?.conclusion || ciMain?.status || 'unknown',
  smokeMain: smokeMain?.conclusion || (smokeMain ? smokeMain.status : 'pending'),
  smokeNote: smokeMain ? smokeMain.url : smokeLatest ? `No smoke run for ${mainSha} yet; latest was ${smokeLatest.conclusion} on ${smokeLatest.headSha.slice(0, 7)}.` : 'No smoke runs found.',
  syncedAt: now, syncedBy: 'Claude Code /tracker-sync', program: 'SmartRemit upgrade program 2026-09',
  prodDeploy: prodDeployState(),
  ...(prevState ? { currentPhase: prevState.currentPhase } : {}),
});
for (const e of events) {
  const id = `${e.at.replace(/[-:]/g, '').slice(0, 15)}-${createHash('sha1').update(e.title + e.at).digest('hex').slice(0, 8)}`;
  put('events', id, e);
}

const batches = []; let cur = []; let size = 0;
for (const w of writes) { const b = readFileSync(w.file_path).length + 400; if (cur.length && (size + b > 900_000 || cur.length === 50)) { batches.push(cur); cur = []; size = 0; } cur.push(w); size += b; }
if (cur.length) batches.push(cur);
batches.forEach((b, i) => writeFileSync(join(OUT, `batch-${i}.json`), JSON.stringify(b)));
console.log(JSON.stringify({ mainSha, ciMain: ciMain?.conclusion, smokeMain: smokeMain?.conclusion ?? 'none', prWrites: writes.filter((w) => w.collection === 'prs').length, events: events.length, fixProposals: fixProposals.length, batches: batches.map((b) => b.length) }));
