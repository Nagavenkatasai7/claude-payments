export const meta = {
  name: 'prod-health-triage',
  description:
    'Overnight: read prod telemetry (dead-letter outbox rows, stuck-paid transfers, stale reviews) READ-ONLY via a SELECT-only Neon role, root-cause each, open a PR of code fixes and a report of ops items needing a human. NEVER writes to prod.',
  phases: [
    { title: 'Observe', detail: 'read-only prod queries for dead / stuck / stale' },
    { title: 'Triage', detail: 'root-cause + classify code-fix vs ops-flag' },
    { title: 'Artifact', detail: 'PR of code fixes + report of ops flags' },
  ],
}

const ISSUES = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['dead_outbox', 'stuck_transfer', 'stale_review'] },
          detail: { type: 'string' },
          lastError: { type: 'string' },
        },
        required: ['id', 'kind', 'detail', 'lastError'],
        additionalProperties: false,
      },
    },
    note: { type: 'string' },
  },
  required: ['issues', 'note'],
  additionalProperties: false,
}

const TRIAGE = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    klass: { type: 'string', enum: ['code_fix', 'ops_flag', 'wont_fix'] },
    rootCause: { type: 'string' },
    fix: { type: 'string' },
    opsAction: { type: 'string' },
  },
  required: ['id', 'klass', 'rootCause', 'fix', 'opsAction'],
  additionalProperties: false,
}

phase('Observe')
const observed = await agent(
  'READ-ONLY production health snapshot. Use the read-only connection string in env DATABASE_URL_READONLY (a SELECT-only Neon role — it physically cannot write). First read src/db/schema.ts for exact table/column names (outbox, transfers, the reviews/compliance tables). Then run SELECT-only queries (write a small throwaway script using @neondatabase/serverless with connectionString = process.env.DATABASE_URL_READONLY) to collect, newest first, capped at ~25 total: (1) dead-letter outbox rows (status indicating dead / attempts exhausted) with their last_error; (2) stuck-paid transfers (paid but not delivered, older than 15 minutes); (3) stale OPEN compliance/KYC reviews older than 24h. NEVER select decrypted PII — ids, status, error text, and timestamps only. If DATABASE_URL_READONLY is unset or the connection fails, return issues: [] with a note saying so. Never issue any non-SELECT statement.',
  { label: 'observe', phase: 'Observe', schema: ISSUES },
)
if (observed.issues.length === 0) {
  log('No prod-health issues (' + observed.note + ') — clean no-op.')
  return { issues: 0, note: observed.note }
}

phase('Triage')
const triaged = await pipeline(
  observed.issues,
  (i) =>
    agent(
      'Root-cause this prod issue and classify it. Issue: ' + JSON.stringify(i) +
        '. Trace last_error/state into the repo. code_fix = a code bug you can fix with a regression test (give the fix). ops_flag = needs a prod/ops action (re-instruct a transfer, clear a row, a partner rail is down) — give the opsAction; do NOT act on prod. wont_fix = transient/expected. NEVER propose a production write.',
      { label: 'triage', phase: 'Triage', schema: TRIAGE },
    ),
  // Adversarially verify the code_fix classifications; pass the rest through.
  (t) =>
    t && t.klass === 'code_fix'
      ? agent(
          'Adversarially verify this is a REAL code bug whose fix is safe and needs NO prod write. Root cause: ' + t.rootCause +
            ' | Fix: ' + t.fix + '. Confirm, or downgrade to ops_flag / wont_fix.',
          { label: 'verify', phase: 'Triage', schema: TRIAGE },
        )
      : t,
)
const codeFixes = triaged.filter(Boolean).filter((t) => t.klass === 'code_fix')
const opsFlags = triaged.filter(Boolean).filter((t) => t.klass === 'ops_flag')

phase('Artifact')
const pr = await agent(
  'Produce the morning artifact for the prod-health triage (overnight, unattended — NEVER write to prod, never run a non-SELECT against the DB). (1) For each code fix, apply it + a regression test on a new branch; run the full gate and it MUST pass: ' +
    "find . -name '* 2.ts' -not -path './node_modules/*' -delete; rm -rf .next; npx tsc --noEmit && npx eslint . && npx vitest run && npm run build" +
    '. (2) Write docs/loops/reports/prod-health-<stamp from `date +%Y%m%d`>.md summarizing every issue, its root cause, and the OPS-FLAG items that NEED A HUMAN (with the exact opsAction). Commit both on branch loop/prod-health-<stamp>, push, and `gh pr create` titled "loop(prod-health): fixes + ops flags". End commit/PR body with: Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>. Never merge it. If there are only ops flags and no code fixes, still open the report-only PR. End with the PR url + counts. Code fixes: ' +
    JSON.stringify(codeFixes) + ' | Ops flags: ' + JSON.stringify(opsFlags),
  { label: 'artifact', phase: 'Artifact', isolation: 'worktree' },
)
return { issues: observed.issues.length, codeFixes: codeFixes.length, opsFlags: opsFlags.length, pr }
