# WhatsApp UX — `get_quote` Cap Guard (Bundle D) — Design

**Status:** design drafted 2026-05-29, approved. Branches off `main` at Bundle C (PR #19, suite **617**).

**Sub-project:** the last queued bot-UX guardrail. Today `get_quote` (`src/lib/tools.ts:502`) computes a quote with **no cap check** — the system prompt merely *instructs* the model to call `check_send_limit` before `get_quote`. If the model skips that step, the bot will happily present a quote for an amount the sender cannot actually send (e.g. quote $2,000 when the sender is capped at $500/day), and the wall is only hit later at the approve step (`send_approve_picker` does enforce the cap). Bundle D makes `get_quote` **self-guarding in code** so an unfulfillable quote can never be shown.

This is a small, **additive, defense-in-depth** batch. It does **not** remove or weaken any existing gate — it adds the *earliest* one.

---

## Goal

`get_quote` refuses (with the max) instead of quoting when the sender is over-cap or restricted, so the bot never presents a quote it can't fulfill. Three user-approved decisions:

1. **Over-cap behavior = refuse + name the max.** When over-cap (or Suspended / verification-required), `get_quote` returns a **cap result** (no quote) carrying `today_remaining_usd` / `per_transfer_cap_usd` / `daily_cap_usd` / `reason` / `tier` / `kyc_url?`, so the bot can say "You can send up to $X right now."
2. **Offer, then wait.** The bot offers the max and **waits for a yes**; it does not auto-re-quote at the max. When the sender confirms ("yes, $500"), the bot calls `get_quote($500)`, which now passes the guard and returns the quote.
3. **Caps-only.** `get_quote`'s guard covers caps + tier only. **EDD stays exactly where it is** — surfaced by `check_send_limit` and collected just before the approve card. `get_quote` does not touch EDD.

## The invariant

> **The quote MATH is byte-for-byte unchanged.** When the sender is within cap, `get_quote` returns the exact same object it returns today (`quote()` is called identically — same fee/rate/INR/source fields). The ONLY change is a **new pre-check** that, when `evaluateCap` reports `withinCap === false`, returns a cap result **instead of** a quote — using the **same shape `check_send_limit` already returns** (minus the EDD fields), so the bot handles it with prompt rules it already has (`over_per_transfer_cap` / `over_daily_cap` / `verification_*`). No existing gate is removed: `check_send_limit` is unchanged (still the primary cap + EDD + new-customer `kyc_url` surface, still called first per the prompt), and `send_approve_picker` + `create_transfer` still re-check the cap. This batch only adds the earliest backstop for the case where the model skipped `check_send_limit`. `bot-content-guard` stays green; within-cap senders and new customers see identical behavior. The existing `get_quote` happy-path tests stay green unchanged — the executable proof that the quote path is untouched when within cap.

## Locked design decisions (2026-05-29, approved)

1. **Cap guard inside `getQuoteTool`.** After computing `amountSource` (from `amount_usd`, or back-solved from `amount_inr` via `sourceForInr` — both paths guarded), convert to USD-equivalent (`amountSource * rates.toUsd`), fetch `dailyVolumeStore.getTodayCents`, and run `evaluateCap(customer, new Date(), todayUsedCents, requestedCents)`. If `!withinCap`, return the cap result and do **not** call `quote()`.
2. **Cap result shape mirrors `check_send_limit` (caps-only).** `{ within_cap: false, tier, reason, daily_cap_usd, per_transfer_cap_usd, today_used_usd, today_remaining_usd, day_of_window, kyc_url? }`. `kyc_url` is fetched (via `ctx.kycProvider.startVerification`) only for `tier === 'T0' || 'Suspended'`, exactly as `check_send_limit` does. **No `edd_*` fields** (caps-only).
3. **Success path unchanged.** When within cap, the return object is byte-for-byte today's quote (no `within_cap` field added — the bot distinguishes a quote from a refusal by the presence of `fee_usd` vs `within_cap: false`).
4. **`check_send_limit` stays.** Unchanged. It remains the prompt's first call (for EDD + new-customer `kyc_url` + status-only `amount_usd: 0`). `get_quote`'s guard is the code backstop for when the model skips it. The prompt keeps "call `check_send_limit` before `get_quote`" and gains a short note that `get_quote` may itself return a cap refusal (handle it identically — offer the max, wait for a yes).
5. **Conventions.** TDD per task; `fakeRedis()`; no `as any`; bot stays partner-/PII-blind (`bot-content-guard` green); commit prefix `feat(wa-ux-d):`; one atomic commit per task; final independent opus review → PR → hold for "deploy."

---

## Architecture

### `getQuoteTool` (`src/lib/tools.ts`) — add the guard

Current happy path (lines 502–543) calls `quote()` and returns the quote. The change: destructure `customer` from `resolveCurrencyAndRates`, compute the USD-equivalent, run `evaluateCap`, and branch:

```
getQuoteTool(args, ctx):
  transferCount = store.getTransferCount(phone)
  { customer, sourceCurrency, rates } = resolveCurrencyAndRates(ctx, args.source_currency)
  amountSource = (finite,>0 amount_inr) ? sourceForInr(amount_inr, rates) : Number(amount_usd)

  # NEW (Bundle D) — cap/tier guard BEFORE quoting
  amountUsd = round2(amountSource * rates.toUsd)
  todayUsedCents = dailyVolumeStore.getTodayCents(phone)
  ev = evaluateCap(customer, new Date(), todayUsedCents, round(amountUsd*100))
  if !ev.withinCap:
     kycUrl = (ev.tier in {T0,Suspended}) ? kycProvider.startVerification(...).url : undefined
     return { within_cap:false, tier, reason, daily_cap_usd, per_transfer_cap_usd,
              today_used_usd, today_remaining_usd, day_of_window, kyc_url }

  q = quote(amountSource, sourceCurrency, rates, funding_method, transferCount)   # unchanged
  return { ...today's quote fields... }                                          # unchanged
```

`QuoteError` handling (the surrounding `try/catch`) is unchanged. The guard runs **before** `quote()`, so an over-cap amount never reaches the quote math.

### Prompt (`src/lib/prompt.ts`) — small note

Keep the existing "BEFORE you call `get_quote`, ALWAYS call `check_send_limit`" block (it still serves EDD + onboarding). Add: `get_quote` may itself return `within_cap: false` (the same cap shape) — if so, treat it exactly like a `check_send_limit` refusal: offer the max (`today_remaining_usd` / `per_transfer_cap_usd`) or send the `kyc_url`, and wait for the sender to confirm before re-quoting. Do not present any quote numbers on a refusal.

---

## Data model changes

**None.** No type, Redis key, or schema change. No migration.

---

## Testing (TDD, `fakeRedis()`)

- **Over per-transfer cap:** a T0 sender (cap $500) quoting $700 → `within_cap: false`, `reason: 'over_per_transfer_cap'`, `kyc_url` present, **no `fee_usd`**.
- **Over daily cap:** seed `dailyVolumeStore` near the cap, quote an amount that exceeds the remainder → `within_cap: false`, `reason: 'over_daily_cap'`, `today_remaining_usd` correct.
- **Receive-first over-cap:** `get_quote({ amount_inr: <huge> })` whose back-solved USD-equiv exceeds the cap → refused (the guard covers the `amount_inr` path too).
- **Within cap still quotes:** a within-cap amount returns the full quote (`fee_usd`, `amount_inr`, `fx_rate`, …) and **no `within_cap` field** — i.e. the existing happy-path tests stay green unchanged.
- **Suspended/verification:** (covered by the per-transfer/daily cases via `reason`/`tier`) — a restricted tier yields `kyc_url` and no quote.
- **`bot-content-guard`** stays green.

Estimated suite delta ≈ **+5 to +8** (617 → ~622–625).

---

## Tasks (subagent-driven, one atomic commit each)

1. **`get_quote` cap guard** — add the `evaluateCap` pre-check + cap-result return to `getQuoteTool`; tests (over-per-transfer, over-daily, receive-first over-cap, within-cap still quotes). `tools.test.ts`.
2. **Prompt note** — `get_quote` may return a cap refusal; handle like `check_send_limit` (offer max, wait). `prompt.test.ts`.
3. **Wrap** — `bot-content-guard` green; full gate (typecheck/lint/vitest/build); independent opus final review; PR; hold for "deploy."

## Risks & mitigations

- **Double cap fetch (check_send_limit then get_quote both read `getTodayCents`).** Negligible (two Redis reads); the values are consistent within a turn. Accepted.
- **Bot confusion on the new `get_quote` refusal shape.** Mitigated: the shape is identical to `check_send_limit`'s refusal, which the prompt already handles; plus the explicit prompt note (Task 2).
- **Within-cap regression.** Mitigated: `quote()` is called identically and the existing happy-path tests stay green unchanged (the invariant's executable proof).

## Open questions

None — the three design forks were resolved with the user (refuse+max, offer-then-wait, caps-only).
