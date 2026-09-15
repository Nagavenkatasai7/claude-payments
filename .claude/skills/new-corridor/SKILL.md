---
name: new-corridor
description: Ground-truth checklist for adding a country/currency corridor the way HKD and Mexico/MXN (#214) were added — live-FX check, types, fallback rates, calling code, bank fields, partner defaults, prompt/tool copy counts, compliance rule, tests, docs. Use when asked to add a corridor, country, or currency.
argument-hint: "<COUNTRY_CODE> <CURRENCY> [calling code]"
---
# /new-corridor — add a corridor without missing a touchpoint

Do not start editing. This is a superpowers job: brainstorm → spec → plan → TDD. Args: `$ARGUMENTS`.

## 0. Ground truth before design
- Live FX must exist: `curl -s "https://api.frankfurter.app/latest?from=USD&to=<CCY>"`. No rate → the corridor would run on FALLBACK only; decide with the user.
- Template = the last expansion: `git show 5647e56 --stat` and `cat tests/mxn-corridor.test.ts`.
- Find every hard-coded enumeration: `grep -rn "'MX'\|MXN" src tests -l` (each file MXN touched is a candidate) and `grep -rn "10 corridors\|ten\b" src/lib/prompt.ts src/lib/tools.ts src/app`.
- Calling code ambiguity (+1, +7, +44 …) needs an explicit rule in the spec; +52 (MX) was unambiguous.

## 1. Spec → `docs/superpowers/specs/<date>-<ccy>-corridor-design.md`
Locked decisions: country/currency/calling code(s); payout fields + validation (`digits`, `isAccount`); fallback `{ toUsd, toInr }`; which partners serve it by default; per-corridor compliance rule + KYC tier; what the bot says for unsupported neighbours.

## 2. Touchpoints (from #214 — verify each still exists before editing)
| File | Change |
|---|---|
| `src/lib/types.ts` | `CountryCode`, `CurrencyCode`, `DEFAULT_CURRENCY_FOR_COUNTRY` |
| `src/lib/rate.ts` | `FALLBACK_FX_RATES.<CCY>` |
| `src/lib/partner-currency.ts` | `CALLING_CODE_TO_COUNTRY`, `countryForCurrency` |
| `src/lib/payout-format.ts` | `BANK_FIELDS_BY_COUNTRY.<CC>` + validation |
| `src/lib/defaults.ts` | `DEFAULT_PARTNER_COUNTRIES` |
| `src/lib/prompt.ts`, `src/lib/tools.ts` | corridor lists, the count, `capture_corridor_request` description, unsupported-destination examples |
| `src/lib/compliance-config.ts` | default per-corridor rule |
| `src/app/page.tsx`, `src/app/partners*` | public corridor list + partner-with-us allow-list |
| `src/app/admin-dashboard/corridors/` | platform corridor view |
| `src/db/schema.ts` | only if a column is needed (then the migration rules apply) |

## 3. Tests first (red → green)
- New `tests/<ccy>-corridor.test.ts` mirroring `tests/mxn-corridor.test.ts` (currency map, phone→country, fallback rate, bank fields, validation pass/fail, default tenant).
- Update count/list assertions: `tests/prompt.test.ts`, `tests/tools.test.ts`, `tests/partner-store.test.ts` (grep the old count).
- Quote path: the fetch stub for the new currency (tests stub Frankfurter; never hit the network in vitest).

## 4. Verify
`npm run typecheck && npm run lint && npx vitest run tests/<ccy>-corridor.test.ts tests/prompt.test.ts tests/tools.test.ts`, then a Claude-in-Chrome walk-through of the pay page quoting the new currency. PR title: `feat(corridors): <Country>/<CCY> corridor`.
