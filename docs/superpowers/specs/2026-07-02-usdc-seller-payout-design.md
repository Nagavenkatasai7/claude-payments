# USDC seller-payout option — design spec

**Date:** 2026-07-02
**Status:** Approved design → implementation
**Author:** Claude (brainstormed with the project owner)

## Summary

A registered cross-border **seller** may choose to RECEIVE payouts as **USDC to a wallet
address** instead of a bank account. Everything else is unchanged: the buyer still pays
in their own currency from their local bank; the licensed **partner rail** still executes
both halves of the signed instruction (collect from the buyer → deliver to the seller) —
the delivery half simply becomes a **stablecoin transfer** instead of a bank deposit.
**SmartRemit never holds funds — fiat or crypto.**

From the user's 6-step feature request (2026-07-01), steps 1–4 and 6 were already live
(cross-border B2B invoicing, PR #204); this spec covers the one genuine delta:
step 5's *"…or enable Stable coin process."*

## Locked decisions

1. **Stablecoin = a seller payout option** (USDC to a wallet address), chosen at
   onboarding. Not buyer-side crypto; not consumer P2P; not SmartRemit custody.
2. **Profile-only payout stands** — the wallet address is captured on the verified
   onboarding page (OTP-gated, encrypted), NEVER from an invoice.
3. **Chain is the partner's concern** — Phase 1 carries only the `0x…` address in the
   signed instruction; the partner rail's configuration determines the chain. A
   per-seller chain selector is a later add if a partner needs it.
4. **Buyer experience is pixel-identical** in both worlds.

## Design

### A. Data model (additive migration 0013)
- `sellers.payout_method` text NOT NULL DEFAULT `'bank'` — `'bank' | 'usdc'`.
- The wallet address reuses the existing encrypted slot: canonical destination string
  `USDC|<0x address>`, stored via the same `payoutDestinationEnc` + `payoutLast4`
  (= the address tail) — same encryption, masking, and audit rules as bank details.
- `Seller` type gains `payoutMethod: SellerPayoutMethod` (`'bank' | 'usdc'`).
- `PayoutMethod` union (transfers) gains `'usdc'` — every exhaustive switch the compiler
  flags is updated (display/formatting only; no money-math depends on it).

### B. Validation (pure, TDD)
- `USDC_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/` (EVM address shape). Reject anything
  else (too short/long, no 0x, non-hex). Pure helper beside the bank-field validation
  in `payout-format.ts` (e.g. `validateUsdcAddress` + a composeUsdcDestination).

### C. Onboarding choice (web-finish page)
- `/onboard/seller/[id]` gains a payout-method toggle: **Bank account** (unchanged
  per-country fields) | **USDC wallet** (one address input).
- Same OTP step-up; same guarded atomic `activateOnboarding` — extended to persist
  `payoutMethod` in the SAME atomic write (guards unchanged: pending + not-needs_review).
- The server action validates the address authoritatively (never trusts the client)
  and composes `USDC|<address>`.

### D. Money flow (non-custodial, unchanged shape)
- The mint (`finalizeCrossBorderBillPayment`) reads the seller profile as today and
  threads `payoutMethod: seller.payoutMethod` onto the transfer ('bank' → payout rail
  `bank` exactly as today; 'usdc' → payout rail `usdc`).
- `buildSettlementInstruction`'s payout leg becomes
  `payout: { rail: 'usdc', destination: '<0x address>' }` for a usdc seller; the
  seller still receives **exactly** the invoiced amount (`amount.destination` unchanged).
- The hosted reference rail (`/api/partner-rail`) accepts `rail:'usdc'` exactly like
  `bank` (verify signature → ack → delayed paid_out callback), so the forward loop
  completes in the simulator.
- Reverse/refund seams unchanged (they act on the funding leg, not the payout leg).

### E. Surfaces
- Receipt (`/account/receipt/[id]`) + admin transfer views: show `USDC wallet ••<tail>`
  instead of `BANK ••<last4>` where the payout method is rendered.
- Onboarding page copy explains the choice in plain language. The bot's
  SELLER ONBOARDING prompt does not change (the choice lives on the secure page).

### F. Out of scope (explicit)
- SmartRemit holding/converting crypto (never), chain selection UI, buyer paying in
  crypto, stablecoin for consumer P2P, wallet-address change flows beyond re-running
  the payout step.

## Invariants to preserve (non-negotiable)
- Non-custodial: the partner executes the stablecoin transfer; no SmartRemit
  crypto/fiat custody anywhere.
- Seller nets EXACTLY the invoiced amount regardless of payout rail.
- Payout destination comes only from the verified, encrypted seller profile.
- Sanctions screening always runs (unchanged); tenant isolation (unchanged);
  OTP-gated activation (unchanged); claim-first idempotent mint (unchanged).
- b2c and bank-payout seller paths byte-unchanged.

## Testing
- Pure: address validation (accept/reject table), canonical compose.
- Repo/PGlite: activateOnboarding persists payoutMethod + encrypted wallet round-trip;
  bank default unchanged.
- Instruction shape: usdc seller ⇒ `payout.rail === 'usdc'`, destination = the raw
  address, `amount.destination` = invoicedAmount exact; bank seller unchanged.
- Simulator rail: acks a `rail:'usdc'` instruction and completes the loop.
- Surfaces: receipt wording for a usdc payout (pure helper level).
