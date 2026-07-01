export const meta = {
  name: 'overnight-bug-hunt',
  description:
    "Overnight: fuzz the TDD'd pure helpers against their invariants; for each real flaw, write a failing test + minimal fix, adversarially verify, and open ONE PR. Read-only until a flaw is confirmed.",
  phases: [
    { title: 'Hunt', detail: 'fuzz each target helper against its invariants (read-only)' },
    { title: 'Verify', detail: 'adversarially confirm each flaw is real + the fix is safe' },
    { title: 'Ship', detail: 'apply confirmed fixes to a branch + open one PR' },
  ],
}

const FINDING = {
  type: 'object',
  properties: {
    module: { type: 'string' },
    flawFound: { type: 'boolean' },
    title: { type: 'string' },
    repro: { type: 'string' },
    rootCause: { type: 'string' },
    proposedFix: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['module', 'flawFound', 'title', 'repro', 'rootCause', 'proposedFix', 'severity'],
  additionalProperties: false,
}

const VERDICT = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    reason: { type: 'string' },
    fixSafe: { type: 'boolean' },
  },
  required: ['real', 'reason', 'fixSafe'],
  additionalProperties: false,
}

// Curated high-value targets: pure helpers + the invariant a fuzzer should attack.
const TARGETS = [
  { module: 'src/lib/fx.ts', inv: 'cross-rate is positive + finite for any supported pair; base-omission handled; round-trip a->b->a within tolerance; no NaN/Infinity on extreme or zero amounts' },
  { module: 'src/lib/phone.ts', inv: 'normalizePhone is idempotent (normalize(normalize(x))===normalize(x)); never throws on malformed/empty/unicode; output is E.164-shaped' },
  { module: 'src/lib/field-crypto.ts', inv: 'decrypt(encrypt(x))===x for any string incl. empty/unicode/very-long; a tampered ciphertext is REJECTED, never silently mis-decrypts' },
  { module: 'src/lib/dates.ts', inv: 'date + window math is stable across DST boundaries and month/year ends; no off-by-one on the observation window' },
  { module: 'src/lib/compliance.ts', inv: 'screening always runs + is structurally untoggleable; a hit blocks; no input shape bypasses the screen' },
  { module: 'src/lib/kyc-state-machine.ts', inv: 'illegal transitions are rejected; no state is both terminal and advanceable; a webhook alone can never auto-approve' },
  { module: 'src/lib/id.ts', inv: 'ids match their documented format/charset; no collision in a large sample' },
  { module: 'src/lib/ip-rate-limit.ts', inv: 'fail-open on backend error (returns allowed); counts monotone within a window; window rollover resets' },
]

phase('Hunt')
const findings = await parallel(
  TARGETS.map((t) => () =>
    agent(
      'You are fuzzing a pure helper for REAL bugs (overnight, unattended). Read ' + t.module +
        ' and its spec (the matching tests/*.test.ts if present). Attack these invariants with adversarial/edge inputs (boundaries, zero, negative, huge, empty, unicode, malformed, DST/month-end where relevant): ' + t.inv +
        '. Find at most ONE concrete, reproducible flaw where the code violates an invariant or crashes. Do NOT invent a flaw — if the helper is sound, set flawFound=false. If you find one, give an exact repro (inputs + observed vs expected) and a minimal proposed fix. READ-ONLY: do not edit any file in this phase.',
      { label: 'hunt:' + t.module.replace('src/lib/', ''), phase: 'Hunt', schema: FINDING },
    ),
  ),
)
const real = findings.filter(Boolean).filter((f) => f.flawFound)
if (real.length === 0) {
  log('No flaws across ' + TARGETS.length + ' targets — clean no-op, no PR.')
  return { targets: TARGETS.length, flawsFound: 0, note: 'clean no-op' }
}

phase('Verify')
const verified = await parallel(
  real.map((f) => () =>
    agent(
      'Adversarially verify this claimed bug — try to REFUTE it. Reproduce the repro exactly against ' + f.module +
        '. Is it a real invariant violation or a misread? Repro: ' + f.repro + ' | Root cause: ' + f.rootCause +
        ' | Proposed fix: ' + f.proposedFix + '. Also judge fixSafe: the fix must NOT weaken/skip existing tests or change intended behavior. Default real=false if uncertain.',
      { label: 'verify:' + f.module.replace('src/lib/', ''), phase: 'Verify', schema: VERDICT },
    ).then((v) => ({ ...f, verdict: v })),
  ),
)
const confirmed = verified.filter(Boolean).filter((f) => f.verdict.real && f.verdict.fixSafe)
if (confirmed.length === 0) {
  log('No flaw survived adversarial verification — clean no-op, no PR.')
  return { targets: TARGETS.length, flawsFound: real.length, confirmed: 0, note: 'none survived verify' }
}

phase('Ship')
const pr = await agent(
  'Apply these CONFIRMED bug fixes and open ONE pull request (overnight, unattended). For EACH flaw: first write a FAILING regression test reproducing it, then the minimal fix, so the test goes red->green. Do NOT weaken or skip any existing test. SCOPE — HARD LIMIT (never violate; a rogue run on 2026-07-01 rewrote CI/vitest config and OOMed CI): edit ONLY the target helper file(s) under src/lib/ that a confirmed flaw lives in, PLUS their matching tests/*.test.ts. You MUST NOT touch .github/** (CI), package.json, vitest.config.ts, tsconfig*, drizzle/**, or ANY file outside the confirmed-flaw modules; you MUST NOT rename, split, move, reformat, or restructure test files or unrelated code; you MUST NOT change the Node version, the test-runner pool, or any memory/timeout config. The WHOLE diff must be SMALL — a failing regression test + a minimal fix per flaw, and nothing else. If a genuine fix appears to require anything beyond that, DO NOT do it: open the PR as a DRAFT describing what is needed, and STOP. Then run the full gate and it MUST pass: ' +
    "find . -name '* 2.ts' -not -path './node_modules/*' -delete; rm -rf .next; npx tsc --noEmit && npx eslint . && npx vitest run && npm run build" +
    '. Create a branch loop/overnight-bug-hunt-<a stamp you generate with `date +%Y%m%d-%H%M`>, commit, push, and `gh pr create` titled "loop(bug-hunt): invariant fixes from the overnight fuzz" with a body listing each flaw + repro + fix. End the commit/PR body with: Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>. If you cannot make the gate green, open the PR as a DRAFT and say why. Never merge it — leave it for morning review. End with the PR url. Confirmed fixes: ' +
    JSON.stringify(confirmed.map((f) => ({ module: f.module, title: f.title, repro: f.repro, fix: f.proposedFix }))),
  { label: 'ship:pr', phase: 'Ship', isolation: 'worktree' },
)
return { targets: TARGETS.length, flawsFound: real.length, confirmed: confirmed.length, pr }
