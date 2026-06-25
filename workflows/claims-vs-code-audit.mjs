export const meta = {
  name: 'claims-vs-code-audit',
  description:
    'Overnight: extract every public product claim (landing, /about, docs) and verify each against what the code actually enforces; adversarially re-check the "supported" verdicts; open a morning report PR. Never edits code or copy.',
  phases: [
    { title: 'Extract', detail: 'list the public claims' },
    { title: 'Audit', detail: 'trace each claim to enforcing code' },
    { title: 'Report', detail: 'write the morning report as a PR' },
  ],
}

const CLAIMS = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          source: { type: 'string' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['id', 'text', 'source', 'risk'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
}

const VERDICT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['supported', 'narrow', 'mismatch', 'unverifiable'] },
    evidence: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['id', 'status', 'evidence', 'note'],
  additionalProperties: false,
}

phase('Extract')
const extracted = await agent(
  'Read the PUBLIC-facing copy and list every concrete product claim a customer or partner could hold us to: src/app/page.tsx (landing), src/app/about/page.tsx, and docs/ (partner docs). Claim types include: non-custodial / "never holds funds", sanctions screening always-on, the fee schedule, the corridor/country count, encryption-at-rest, "licensed partners settle", delivery wording. For each give a short id, the exact claim text, its source file, and a risk level (high = money/compliance/security claims). Do NOT invent claims — only list ones actually present in the copy.',
  { label: 'extract', phase: 'Extract', schema: CLAIMS },
)
if (extracted.claims.length === 0) {
  log('No public claims found — clean no-op.')
  return { claims: 0, note: 'clean no-op' }
}

phase('Audit')
const verdicts = await pipeline(
  extracted.claims,
  (c) =>
    agent(
      'Verify this public claim against what the CODE actually enforces. Claim: ' + JSON.stringify(c) +
        '. Trace it to the enforcing code with file:line. status = supported (code provably enforces it), narrow (true but needs qualification), mismatch (code does NOT enforce it / contradicts it — HIGH RISK for a money company), or unverifiable (no code path decides it). Be conservative: prefer narrow/mismatch over a generous "supported".',
      { label: 'audit', phase: 'Audit', schema: VERDICT },
    ),
  // Adversarially re-check only the "supported" verdicts; pass others through.
  (v, c) =>
    v && v.status === 'supported'
      ? agent(
          'Adversarially re-check a claim marked "supported" — find a case where it is FALSE despite the cited evidence. Claim: "' + c.text +
            '" | Evidence: ' + v.evidence + '. If you find a gap, downgrade to narrow or mismatch; otherwise confirm supported.',
          { label: 'recheck', phase: 'Audit', schema: VERDICT },
        )
      : v,
)

const flagged = verdicts.filter(Boolean).filter((v) => v.status === 'mismatch' || v.status === 'narrow')

phase('Report')
const pr = await agent(
  'Write a concise morning report (markdown) of a claims-vs-code audit for a money-movement company. Summarize: total claims audited, count supported, and EVERY mismatch/narrow with its claim text, the code evidence, and a suggested fix (narrow the copy, or fix the code). HIGH-RISK mismatches first. This is READ-ONLY about the product: do NOT edit any code or marketing copy. Write the report to docs/loops/reports/claims-audit-<stamp from `date +%Y%m%d`>.md (create the dir), on a new branch loop/claims-audit-<stamp>, commit, push, and `gh pr create` titled "loop(claims-audit): morning report" so it is reviewable. End commit/PR body with: Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>. Never merge it. End with the PR url + a one-line summary (e.g. "2 high-risk mismatches, 1 narrow"). Verdicts: ' +
    JSON.stringify(verdicts.filter(Boolean)),
  { label: 'report', phase: 'Report', isolation: 'worktree' },
)
return { claims: extracted.claims.length, flagged: flagged.length, pr }
