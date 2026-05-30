# `get_quote` Cap Guard (Bundle D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `get_quote` refuse (with the max) instead of returning a quote when the sender is over-cap or restricted, so the bot never presents an unfulfillable quote.

**Architecture:** Add a `evaluateCap` pre-check inside `getQuoteTool` (`src/lib/tools.ts`) that runs on the resolved USD-equivalent amount (covers both `amount_usd` and the receive-first `amount_inr` path). On `!withinCap` it returns a cap result shaped like `check_send_limit`'s (caps-only — no EDD); otherwise the quote path is byte-for-byte unchanged. `check_send_limit` is untouched.

**Tech Stack:** Next.js 16, TypeScript, Vitest, Upstash Redis (`fakeRedis()`). Spec: `docs/superpowers/specs/2026-05-29-quote-cap-guard-design.md`.

**Conventions:** TDD per task; one atomic commit per task; commit prefix `feat(wa-ux-d):`; no `as any`; `rm -rf .next` before `npm run typecheck` if a stale-cache "Duplicate identifier" appears. Suite baseline **617** green.

---

### Task 1: `get_quote` cap guard

**Files:**
- Modify: `src/lib/tools.ts` — `getQuoteTool` (currently lines ~502–543): destructure `customer` and insert the guard before the `quote()` call.
- Test: `tests/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/tools.test.ts` (it imports `executeTool`, `fakeRedis`, defines `buildCtx`; `MOCK_RATE = 85.0`; a fresh `buildCtx` customer is a T0 sender with a $500/day + $500/transfer cap):

```typescript
describe('get_quote cap guard (Bundle D)', () => {
  it('refuses an over-per-transfer amount with a cap result (no quote)', async () => {
    const ctx = buildCtx(fakeRedis());
    const r = await executeTool('get_quote', { amount_usd: 700, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_per_transfer_cap');
    expect(r.fee_usd).toBeUndefined();        // NO quote presented
    expect(r.amount_inr).toBeUndefined();
    expect(typeof r.kyc_url).toBe('string');  // T0 → kyc_url surfaced
    expect(r.per_transfer_cap_usd).toBe(500);
  });

  it('refuses an over-daily amount and reports the remaining', async () => {
    const ctx = buildCtx(fakeRedis());
    await ctx.dailyVolumeStore.addCents(PHONE, 40_000); // $400 already used today
    const r = await executeTool('get_quote', { amount_usd: 200, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_daily_cap');
    expect(r.today_remaining_usd).toBe(100); // $500 cap − $400 used
    expect(r.fee_usd).toBeUndefined();
  });

  it('guards the receive-first (amount_inr) path too', async () => {
    const ctx = buildCtx(fakeRedis());
    // 70000 INR / 85 ≈ $823 USD-equiv → over the $500 per-transfer cap
    const r = await executeTool('get_quote', { amount_inr: 70000, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.fee_usd).toBeUndefined();
  });

  it('still returns a normal quote when within cap (no within_cap field)', async () => {
    const ctx = buildCtx(fakeRedis());
    const r = await executeTool('get_quote', { amount_usd: 300, funding_method: 'bank_transfer' }, ctx);
    expect(r.within_cap).toBeUndefined();     // success path unchanged
    expect(r.fee_usd).toBe(0);                // first transfer free
    expect(r.amount_inr).toBe(Math.round(300 * MOCK_RATE));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools.test.ts -t "cap guard"`
Expected: FAIL — over-cap calls currently return a quote (`fee_usd` defined, `within_cap` undefined).

- [ ] **Step 3: Add the guard to `getQuoteTool`**

In `src/lib/tools.ts`, change the destructure (currently `const { sourceCurrency, rates } = await resolveCurrencyAndRates(ctx, args.source_currency);`) to include `customer`:

```typescript
    const { customer, sourceCurrency, rates } = await resolveCurrencyAndRates(ctx, args.source_currency);
```

Then insert this block **between** the `amountSource` assignment and the `const q = quote(...)` call (i.e. right after the receive-first `amountSource` block, before `const q = quote(`):

```typescript
    // Cap/tier guard (Bundle D) — refuse BEFORE quoting so the bot never presents
    // an unfulfillable quote. Mirrors check_send_limit's cap result (caps-only; EDD
    // is unchanged and stays on check_send_limit). Runs on the resolved amountSource,
    // so it covers the amount_inr (receive-first) path too. Only when the amount is
    // finite — a missing/NaN amount falls through to quote()'s "valid amount" error.
    const amountUsd = Math.round(amountSource * rates.toUsd * 100) / 100;
    if (Number.isFinite(amountUsd)) {
      const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
      const ev = evaluateCap(customer, new Date(), todayUsedCents, Math.round(amountUsd * 100));
      if (!ev.withinCap) {
        let kycUrl: string | undefined;
        if (ev.tier === 'T0' || ev.tier === 'Suspended') {
          const start = await ctx.kycProvider.startVerification({
            customerId: ctx.phone,
            senderPhone: ctx.phone,
          });
          kycUrl = start.url;
        }
        return {
          within_cap: false,
          tier: ev.tier,
          reason: ev.reason,
          daily_cap_usd: ev.dailyCapCents / 100,
          per_transfer_cap_usd: ev.perTransferCapCents / 100,
          today_used_usd: ev.todayUsedCents / 100,
          today_remaining_usd: ev.todayRemainingCents / 100,
          day_of_window: ev.dayOfWindow,
          kyc_url: kycUrl,
        };
      }
    }
```

(`evaluateCap` is already imported at the top of the file: `import { evaluateCap, evaluateEdd } from './tier-rules';`. No new import needed.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tools.test.ts -t "cap guard"` then the full file `npx vitest run tests/tools.test.ts`
Expected: PASS, including the pre-existing `get_quote` tests (the within-cap `$500` free-quote and the `$5` "between" validation-error tests both still pass — `$500` is exactly at cap = within, `$5` is within cap so it falls through to `quote()`'s QuoteError).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tools.ts tests/tools.test.ts
git commit -m "feat(wa-ux-d): get_quote refuses over-cap before quoting (cap guard)"
```

---

### Task 2: Prompt note — `get_quote` may return a cap refusal

**Files:**
- Modify: `src/lib/prompt.ts`
- Test: `tests/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/prompt.test.ts`:

```typescript
describe('SYSTEM_PROMPT — get_quote cap refusal (Bundle D)', () => {
  it('tells the bot get_quote may itself return a cap refusal to handle like check_send_limit', () => {
    expect(SYSTEM_PROMPT).toContain('get_quote');
    // the within_cap-false handling note must be present
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('within_cap');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/prompt.test.ts -t "cap refusal"`
Expected: FAIL — `within_cap` not yet mentioned in `SYSTEM_PROMPT`.

- [ ] **Step 3: Add the prompt note**

In `src/lib/prompt.ts`, find the `NEW-CUSTOMER ONBOARDING & SENDING LIMITS` section's cap block (the bullet beginning `- BEFORE you call get_quote, ALWAYS call check_send_limit ...`). Immediately **after** that bullet's sub-list (the four `over_per_transfer_cap` / `over_daily_cap` / `verification_*` lines) and before the `- For Suspended users ...` bullet, insert:

```
- get_quote ALSO guards the cap itself: it may return { within_cap: false, ... }
  (the same shape as check_send_limit) instead of a quote. If it does, do NOT show
  any quote numbers — handle it exactly like a check_send_limit refusal: offer the
  max (today_remaining_usd / per_transfer_cap_usd) or share the kyc_url, and wait
  for the sender to confirm an amount before quoting again.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/prompt.test.ts -t "cap refusal"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompt.ts tests/prompt.test.ts
git commit -m "feat(wa-ux-d): prompt — get_quote may return a cap refusal, handle like check_send_limit"
```

---

### Task 3: Wrap (guard + gate + review + PR)

**Files:** none expected (verification only).

- [ ] **Step 1: bot-content-guard + full gate**

```bash
npx vitest run tests/bot-content-guard.test.ts   # expect green
rm -rf .next
npm run typecheck   # TYPECHECK_OK
npm run lint        # LINT_OK
npx vitest run      # ~622–625 passed, 0 failed
npm run build       # BUILD_OK
```

If any forbidden term (partner/corridor/watchlist/sanctions/provider/PII) is flagged in the new prompt note or `get_quote` strings, reword and re-run.

- [ ] **Step 2: Independent final review (opus, read-only)**

Dispatch one adversarial reviewer over `main..HEAD`. Invariant focus: `quote()` math byte-for-byte unchanged on the within-cap path; the cap guard runs on the USD-equivalent and covers the `amount_inr` path; a missing/invalid amount still yields `quote()`'s `QuoteError` (not a cap result); the refusal shape matches `check_send_limit` (caps-only, no EDD added); `check_send_limit`, `send_approve_picker`, and `create_transfer` cap checks are all still present (defense in depth intact); `bot-content-guard` green. Fold in any Critical/Important findings; re-run the gate.

- [ ] **Step 3: Open the PR (hold the merge for the user's "deploy")**

```bash
git push -u origin spec/wa-ux-quote-cap-guard
gh pr create --base main --head spec/wa-ux-quote-cap-guard \
  --title "feat(wa-ux-d): get_quote cap guard" \
  --body "<summary: get_quote refuses over-cap (refuse+max, offer-then-wait, caps-only) before quoting; quote math unchanged within cap; check_send_limit/approve/create cap checks intact; suite ~623; gate + final review green>"
```

Report the PR is ready and **hold the prod merge for the user's explicit "deploy".**

---

## Self-Review (against the spec)

**Spec coverage:** Decision 1 (refuse+max) → Task 1 cap result. Decision 2 (offer-then-wait) → Task 2 prompt ("wait for the sender to confirm"). Decision 3 (caps-only) → Task 1 returns no `edd_*` fields. Invariant (quote math unchanged within cap) → Task 1 leaves `quote()` + the success return untouched; existing tests stay green. `check_send_limit` unchanged → not modified in any task. ✓

**Placeholder scan:** none — every code step is complete. ✓

**Type/name consistency:** `evaluateCap`, `customer`, `ev`, `kycUrl`, the cap-result keys (`within_cap`/`tier`/`reason`/`*_usd`/`day_of_window`/`kyc_url`) all match `check_send_limit`'s existing shape. ✓
