# SmartRemit — Verified Codebase Feature Map

_Ground-truth inventory built by a 9-agent parallel exploration (each claim carries file:line evidence). Statuses: **built** · **partial** · **mocked** · **scaffolded_dormant** · **not_built**._

## Bot & conversation

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Agent loop (completeTurn) — multi-round tool dispatch (MAX_TOOL_ROUNDS=6) | ✅ built | src/lib/agent.ts:96-307; MAX_TOOL_ROUNDS=6 (line 19); executeTool dispatch 229-240; results pushed back 261-265; continue on tool_calls 267 | Core loop: history + injected notes -> LLM -> tool calls -> results -> append -> repeat, up to 6 rounds/turn. |
| Graceful error handling + fallback reply (single Ollama retry, per-tool isolation) | ✅ built | src/lib/agent.ts:19-21 (FALLBACK_REPLY), 59-68 (chatWithRetry), 71-94 (runAgentTurn try/catch), 225-244 (per-tool try/catch -> {error}) | One transparent retry on chat() failure; turn-level catch preserves history (enables resend); one tool throw != turn failure. |
| sanitizeReply — anti-hallucination URL guard (strip model URLs, append only canonical links) | ✅ built | src/lib/agent.ts:42-53; regex strips https?://\S+; appends only code-minted paymentLinks; called at line 304 | Critical defense vs typo-squatting: model never emits its own URLs; all payment links minted by code. |
| Interactive card suppression (no duplicate trailing text) | ✅ built | src/lib/agent.ts:124 (interactiveSent), 246 (set on result.sent), 298-301 (return '') | When a tool sends a WhatsApp interactive card the agent returns empty string so the card is the reply. |
| Deterministic verify-link backstop guardian | ✅ built | src/lib/agent.ts:274-293; looksLikeVerifyHandoff in src/lib/verify-link.ts:25-28; issueVerifyLink mint | If model says 'verify' but calls no tool and customer is unverified, code mints + appends the canonical link. |
| Round-0 system note: [NEW CUSTOMER] | ✅ built | src/lib/agent.ts:163-169 | First-ever message: must verify before first send; do not quote until KYC link visited. |
| Round-0 system note: [TIER_REMINDER] (day N/3 observation window) | ✅ built | src/lib/agent.ts:170-176 | New conversation while still in 3-day window: remind of day + share verify link, then proceed. |
| Round-0 system note: [UNVERIFIED SENDER] | ✅ built | src/lib/agent.ts:199-210; isSendVerified check | Bot must not collect send details / not call get_quote or send_approve_picker for unverified sender. |
| Round-0 system note: [SEND CURRENCIES] (multi-currency partners) | ✅ built | src/lib/agent.ts:178-187 (inject if sendCurrencies.length>1) | Auto-detect sender currency from phone; don't re-ask; pass source_currency only if explicitly requested. |
| Recent-transfer memory injection ([RECENT TRANSFERS]) | ✅ built | src/lib/agent.ts:113,188-189; getRecentTransfersNote in src/lib/recent-transfers.ts:49-59 | Top 5 most-recent transfers formatted once at round 0; empty string for history-less customers. |
| Sticky funding-method default ([SENDER DEFAULTS], <90 days) | ✅ built | src/lib/agent.ts:118,191-192; getSenderDefaultsNote in src/lib/sender-defaults.ts:21-33 | Reuse last funding method if recent (<90d); avoids re-asking how-to-pay on repeat customers. |
| SYSTEM_PROMPT — master behavioral spec (~151 lines) | ✅ built | src/lib/prompt.ts:1-151 | Language/Hindi/Hinglish, collect rules, 8 destinations, flow, amount limits $10-$2999, last-4 masking, no bank details in chat, unsupported-destination ordering, EDD, verify-before-send. |
| Button-tap context (recipient tap / approve tap / cancel tap) | ✅ built | src/lib/agent.ts:143-162 (recipient hydration), tools.ts:720-789 (approve draftId), tools.ts:1348-1351 (cancel) | WhatsApp button taps inject ctx.turn.buttonTap; server freezes recipient details / supplies draftId so LLM can't fabricate. |
| Conversation history persistence (per-phone Redis, 40-msg trim) | ✅ built | src/lib/agent.ts:76 (getConversation), 305 (saveConversation); src/lib/store.ts:34-48 (MAX_HISTORY 40, trimHistory keeps first msg = user) | Loaded fresh each turn, appended, saved; enables multi-turn context + recovery on partial failure. |
| Ollama LLM backend (OpenAI-compatible chat API, Kimi K2.6) | ✅ built | src/lib/ollama.ts:4-39 (chat); POST {base}/chat/completions; tool_choice='auto'; throws on !ok | Single chat() wrapper; no streaming; tool schemas passed each turn; wrapped by chatWithRetry. |
| Transfer count fetch for first-transfer-free pricing | ✅ built | src/lib/tools.ts:622 + 1176 (getTransferCount); passed to quote() at 687 | Queried before each quote; drives free-fee first transfer. |

## WhatsApp I/O

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Inbound webhook GET verification (hub.mode=subscribe) | ✅ built | src/app/api/whatsapp/route.ts:26-36 | Returns challenge on token match (200), Forbidden (403) otherwise. |
| Inbound webhook POST envelope parsing (messages vs status) | ✅ built | src/lib/whatsapp.ts:96-138 (parseIncoming), 67-94 (parseStatusEvent) | Separates text/button/list_reply messages from status callbacks; both return null on non-match. |
| X-Hub-Signature-256 verification (Meta signature gate, fail-closed when secret set) | ✅ built | src/app/api/whatsapp/route.ts:47-61; verifyMetaSignature; src/lib/providers/meta-signature-verify.ts:17-28 | metaAppSecret='' skips with warning; set value enforces 401; gate sits above dedup so forged bodies can't touch state. |
| Message deduplication (markMessageSeen) | ✅ built | src/app/api/whatsapp/route.ts:97-98 | Returns {ok:true} immediately for re-delivered webhooks; guarded by signature check. |
| STOP/START consent keywords (whole-message, case-insensitive) | ✅ built | src/lib/consent.ts:9-18; route.ts:116-126 (setOptedOut/clearOptedOut + replies, skip agent) | OPT_OUT=['stop','unsubscribe'], OPT_IN=['start','unstop']; substring deliberately excluded. |
| Opt-out state skip (suppress send flow for already-opted-out) | ✅ built | src/app/api/whatsapp/route.ts:127-134 | High-bug fix: opted-out users sending normal text get OPT_OUT_REMINDER, skip agent. |
| Delivery-status callbacks (sent/delivered/read/failed) | 🟡 partial | src/app/api/whatsapp/route.ts:76-91; parseStatusEvent | Structured logging only; 'failed' logs warn (recipientId/wamid/errorCode). No wamid->transfer downstream mapping yet. |
| Free-form sendText | ✅ built | src/lib/whatsapp.ts:198-209 (postWithBackoff) | Always in-session eligible within 24h window; backbone of replies/fallbacks. |
| Interactive reply buttons (sendInteractive, 1-3 buttons) | ✅ built | src/lib/whatsapp.ts:402-455 | HTTP 470 (outside 24h) falls back to numbered text list; used for recipient picker. |
| Interactive CTA-URL button (sendCtaUrl) | ✅ built | src/lib/whatsapp.ts:527-575 | type='cta_url'; validates https + <=20 char text; 470/any error falls back to inline link; used for Approve & Pay. |
| Interactive list message (sendList) | 🌙 scaffolded_dormant | src/lib/whatsapp.ts:470-516; gated behind env.whatsappFlowsEnabled (default false) at tools.ts call site | Scaffolded for Flows; never called in prod. (Source labeled 'partial'; reclassified dormant since disabled by default and never invoked.) |
| Template send with body params (sendTemplate) | ✅ built | src/lib/whatsapp.ts:211-236 | Base template send, no button; throws on non-OK; used by sendTemplateOrText path. |
| Template send with dynamic URL button (sendTemplateWithButton) | ✅ built | src/lib/whatsapp.ts:246-278 | sub_type='url' button with path-safe slug token; used in cron for pay/verify links. |
| AUTHENTICATION template OTP send (sendAuthTemplate) | ✅ built | src/lib/whatsapp.ts:288-308 | Sends Meta AUTHENTICATION template with code in body + COPY_CODE url button; takes components verbatim. |
| OTP delivery sendOtpCode (AUTHENTICATION + free-form fallback) | ✅ built | src/lib/whatsapp.ts:339-362; env.whatsappAuthTemplate default 'verification_code' | Dev mode logs 'code ready' (no code); on any error falls back to sendText; code never appears in logs. |
| Per-transaction step-up OTP send (sendTransactionOtp) | ✅ built | src/lib/whatsapp.ts:610-612; used in src/app/api/pay/[transferId]/route.ts | In-session free-form send; throws on failure so pay route won't finalize; code never logged. |
| Template send with graceful degradation (sendTemplateOrText) | ✅ built | src/lib/whatsapp.ts:374-389 | Tries template, falls back to text, swallows exceptions so cron batches don't abort on one bad recipient. |
| Rate-limit backoff (131056 / 429), linear, 2 retries | ✅ built | src/lib/whatsapp.ts:144-196; BASE_DELAY 6500ms x attempt | 131056 = >1 msg/6s to same user; non-rate-limit errors throw immediately. |
| Verification-status notification (sendVerificationStatus) | ✅ built | src/lib/whatsapp.ts:583-601 | Maps needed/in_progress/received/verified/failed to template names; never throws; degrades to text until templates approved. |
| Button parsing (recipient/approve/cancel IDs) | ✅ built | src/lib/whatsapp-buttons.ts:55-74 (parseButtonId); route.ts:168-174 | Validates prefix:payload (recipient:PHONE / recipient:new / approve:DRAFT / cancel:DRAFT); synthesizes button text. |
| Transactional opt-in backfill (first inbound creates optInAt; idempotent upsert) | ✅ built | src/app/api/whatsapp/route.ts:142-149 (upsertOnFirstInbound / setOptedIn) | New customer opted in at creation; grandfathered records get optInAt on first message. |
| Tier reminder trigger (T0, new conversation, not first message) | ✅ built | src/app/api/whatsapp/route.ts:154-161 | Computes day 1/2/3 from customer age; sets tierReminderDayOfWindow on TurnContext. |
| TurnContext construction (incoming metadata) | ✅ built | src/app/api/whatsapp/route.ts:177-182 | isNewConversation, buttonTap, isNewCustomer, tierReminderDayOfWindow passed to agent. |
| Async agent turn execution (after() hook, fast webhook ack) | ✅ built | src/app/api/whatsapp/route.ts:184-213 | Returns {ok:true} before agent runs; sends reply if non-empty; on error sends generic message (best effort). |
| Meta AUTHENTICATION template approval status | 🟦 mocked | env.ts:99-102; sendOtpCode AUTHENTICATION path falls back to free-form | Template not yet approved in WhatsApp Manager; all OTP sends currently use free-form fallback. |
| Meta §3 template suite approval (scheduled_payment_ready, payment_reminder, transfer_delivered_sender, transfer_in_review/released/cancelled, verification_*) | 🟦 mocked | src/lib/whatsapp-templates.ts:16-22; env.ts:127-138; docs/meta-whatsapp-config.md | Only transfer_delivered (recipient) is approved/live; all sender-side + verification templates pending -> cron degrades to free-form text. |

## Quote / Transfer / Payment

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Live FX rates (Frankfurter API, dual toUsd/toInr, 1h cache, fallback table) | ✅ built | src/lib/rate.ts:43 (api.frankfurter.app); FALLBACK_FX_RATES 12-21; TTL 23 | USD source optimizes to single query (toUsd=1); non-USD fetches both USD and INR. |
| Multi-currency cross-rate quote math (any-to-any via USD pivot) | ✅ built | src/lib/fx.ts:16-84 (quote, destinationCurrency/destToUsd); pivot 65-68 | Non-INR destinations converted via USD pivot; amountInr var holds destination-currency amount. |
| Fee schedule (bank $1.99 / debit $2.99 / credit $2.99+3%, first transfer free) | ✅ built | src/lib/fx.ts:37-58; wouldBeFeeUsd 93-102; transferCount=0 -> feeUsd=0 | Credit scales with amount; fee converted to source currency; rounded to 2 dp. |
| 8-corridor support (US/CA/GB/AE/SG/AU/NZ + IN), IN now valid source | ✅ built | src/lib/partner-currency.ts:5-17,41-53; types.ts:324-326; defaults.ts DEFAULT_DESTINATION_COUNTRY='IN' | Partner.countries[] drives allowed send currencies; IN now a valid SOURCE (any-to-any P4). |
| Receive-first back-solve (amount_inr -> amountSource via sourceForInr) | ✅ built | src/lib/fx.ts:104-120 | Exact inverse of forward quote; re-enforces MIN/MAX via quote(). |
| createTransfer chokepoint with KYC verify gate (senderKycStatus='verified') | ✅ built | src/lib/transfer-create.ts:40-51; throws 'kyc_required' if not verified (line 49) | Atomic last-line-of-defense backstop; callers gate earlier with UX. |
| get_quote tool (FX + fee + destination amount), verify + cap gated | ✅ built | src/lib/tools.ts:140-179 (schema), 617-710; verify gate 629-634; cap 652-676 | Returns source/usd/dest amounts, fx_rate, fee, delivery estimate; enforces SEND AMOUNT LOCK. |
| Per-country bank-detail fields + validation (8 BANK_FIELDS_BY_COUNTRY: IFSC/IBAN/routing/sort/BSB/account) | ✅ built | src/lib/payout-format.ts:64-107; validatePayoutFields 126-165; composePayoutDestination 177-190 | IFSC/IBAN regex patterns; account field placed last (masking priority); permissive (no checksum). |
| Payout masking (last-4 of last digit-run, ****XXXX display) | ✅ built | src/lib/payout-format.ts:208-224 (accountLast4, maskAccountDisplay); pay-form.tsx:319; masked-destination.tsx | UPI ids (no digits) pass through unmasked; max 4 digits leaked. |
| Per-transaction OTP gate on pay page (transaction-otp store) | ✅ built | src/lib/transaction-otp.ts:41-106; pay route 89-114 (request_otp + verify before any charge) | 6-digit bound to txId+phone, sha256 keys, TTL 10min, 30s cooldown, 5 attempts, timing-safe compare, single-use. |
| Two-stage mock delivery (stage1 paid/charge, stage2 delivered after 120s via after()) | ✅ built | src/lib/providers/payment-provider.ts:64-86; src/lib/payment.ts:44-121; DELIVERY_DELAY_MS=120000 | Stage1 blocks pay response; stage2 fires async in background; providerRef='mock-<id>'. |
| in_review hold path (flagged transfers: charge + hold, no delivery until release) | ✅ built | src/app/api/pay/[transferId]/route.ts:33-45; payment.ts held-message; tests/pay-route-in-review.test.ts | Flagged -> stage1 charge with held:true -> status='in_review'; admin must release; blocked skips charge entirely. |
| Draft creation + finalization (create-at-pay, single-use consume, cap re-check) | ✅ built | src/lib/pay-finalize.ts:43-125; pay route 184-215 | Atomic consumeDraft prevents double-pay; bank details collected at pay time; monthly volume accrued after create. |
| Two-step pay page (bank details step + OTP) — SimplePayForm vs BankDetailsPayForm | ✅ built | src/app/pay/[transferId]/page.tsx:65-93 (needsBankDetails); pay-form.tsx:37-66,217-388 | Cold-start/scheduled drafts (empty destination) trigger Step1 bank entry; validation runs client + server (authoritative). |
| Scheduled/cron transfers carry empty destination, collected on pay page | ✅ built | src/app/api/pay/[transferId]/route.ts:160-178; page.tsx:89-92 | No-account transfer never delivered; pay page collects + validates + saves to transfer before processing. |
| Real payment rails (Plaid/FedNow/UPI) | 🟦 mocked | No Plaid/FedNow imports (grep empty); only MockPaymentProvider in src/lib/providers/payment-provider.ts:61-102; UPI is a payout-method label only | Mock returns mock-<id>; real provider would implement PaymentProvider (initiateTransfer/getStatus/handleWebhook). |
| KYC Tier 2 Travel-Rule per-send counterparty data (recipientLegalName/relationship/purpose) | 🟡 partial | src/lib/transfer-create.ts:30-38,114-116; types.ts:70-77 | Fields captured + stored on transfer but not screened or transmitted downstream; no active gatekeeping in P5. |

## Compliance & tiers

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Compliance statuses cleared / flagged / blocked | ✅ built | src/lib/types.ts:13; src/lib/compliance.ts:15-18,39-54; transfer-create.ts:83-88,104 | watchlist hit->blocked (no charge); large/velocity->flagged (charge+hold); EDD only ever adds flag, block always wins. |
| Watchlist screening (hardcoded names) | 🟦 mocked | src/lib/compliance-config.ts:6 ['john doe','jane roe','test blocked']; MockSanctionsScreener src/lib/providers/sanctions-provider.ts:26-36 | Case-insensitive exact match; both recipient and sender screened; real provider (ComplyAdvantage/Sanctions.io) swappable. |
| SanctionsScreener seam (pluggable factory) | ✅ built | src/lib/providers/sanctions-provider.ts:16-18,40-42 (getSanctionsScreener); compliance.ts:30-32 | Swap implementation without touching call sites; baseList = GLOBAL_DEFAULTS + corridor watchlistExtra. |
| Sender + recipient screening | ✅ built | src/lib/compliance.ts:27,35-39; transfer-create.ts:36,73 (senderName from customer.fullName) | senderName optional (undefined -> no-op); both share MockSanctionsScreener; recipientLegalName distinct from display name. |
| Velocity limits (per-day transfer count, >=5 flags) | ✅ built | src/lib/compliance-config.ts:11 VELOCITY_LIMIT=5; compliance.ts:50-51; transfer-create.ts:61 getTodayTransferCount; daily-volume-store.ts | Count-based (not amount); per-corridor override possible; 48h TTL Eastern-date keyed. |
| Amount + EDD thresholds (large-amount $1000 per-transfer flag; EDD $3000 cumulative monthly) | ✅ built | src/lib/tier-rules.ts:60 EDD_THRESHOLD_CENTS=300000, 71-79 evaluateEdd, 10 LARGE_AMOUNT_USD=1000; compliance.ts:47-48 | Large amount is per-transfer flag; EDD is cumulative monthly; per-corridor overrides available. |
| Tier system T0 -> T1 -> Suspended (3-day observation window) | ✅ built | src/lib/tier-rules.ts:1-14 (deriveTier), 16-58 (evaluateCap); T0_DAILY_CAP=$500, T1=$2,999, OBSERVATION_WINDOW=3d | T0 within 3d of firstSeenAt; verified/grandfathered graduate to T1 after window; rejected -> Suspended; pending+out-of-window -> Suspended. |
| Daily caps + per-transfer cap (T0 $500/day, T1 $2,999/day, per-transfer = daily cap) | ✅ built | src/lib/store.ts:127-133 (velocity count); daily-volume-store.ts:14-23 (cents, 48h TTL); tier-rules.ts:3-4 | Eastern-date boundary; dollar cap separate from velocity transfer-count flag. |
| Per-corridor compliance rules (watchlistExtra/largeAmountUsd/velocityLimit/kycCapHintUsd) | 🌙 scaffolded_dormant | src/lib/compliance-config.ts:37-64 (resolveCorridorRules); CORRIDOR_DEFAULTS empty at ship (line 35); types.ts:367,379-384 | Cascade partner-override >> corridor-default >> GLOBAL_DEFAULTS; watchlistExtra concatenated; default partner never gets corridor config; kycCapHintUsd advisory-only (unread in P5). Mechanism built but no corridors populate it -> dormant. |
| Hold-for-review flow (in_review status; admin release/reject) | ✅ built | src/app/api/pay/[transferId]/route.ts:33-45; src/lib/dashboard-ops.ts:47-75 (releaseTransfer/rejectTransfer) | Only flagged enter in_review; release -> stage2 delivery; reject -> cancelled + adminNote (mock refund). |
| Monthly volume store (cumulative EDD accrual, Eastern-month, 35-day TTL) | ✅ built | src/lib/monthly-volume-store.ts:14-23; transfer-create.ts:66,122 | Accrued at transfer creation; used by evaluateEdd to detect $3k crossing. |
| EDD required flag (cross-month cumulative trigger, flags if source_of_funds/occupation missing) | ✅ built | src/lib/tier-rules.ts:71-91 (evaluateEdd / evaluateEddForTransfer); transfer-create.ts:77-88,117 | Inclusive at $3k; never blocks, only flags; eddRequired snapshot persisted for audit. |
| Enhanced verification (EDD) — source_of_funds + occupation collection on $3k threshold | ✅ built | src/lib/tools.ts:132-135 (enums), 207-211/385-389/298-302 (schema fields); persistEddProfile 870-882; check_send_limit returns edd_required 1438-1439 | Phase 4 KYC; sticky on customer (eddCapturedAt) so not re-asked; repeat_transfer returns needs_edd when missing. |
| Blocked attempts audit trail (recordBlockedAttempt) | ✅ built | src/lib/transfer-create.ts:139-203 | Writes status='blocked' row, never charged, skips velocity/daily/monthly counters, no recipient upsert; visible in ledger for audit. |
| Compliance screening at card-show (send_approve_picker) + blocked-attempt recording | ✅ built | src/lib/tools.ts:1172-1220 (screenTransfer + recordBlockedAttempt) | Read-only screen before draft creation; relays reply_to_customer as-is, never mentions compliance/watchlists. |
| KYC Tier 4 EDD framework (dormant enforcement) | 🟡 partial | src/lib/transfer-create.ts:77-88; tier-rules.ts EDD logic; Transfer.eddRequired stored line 117 | Trigger-based; sourceOfFunds/occupation captured + sticky but not actively enforced as a hard gate in this batch. |

## KYC & onboarding

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Persona KYC provider (real sandbox REST integration) | ✅ built | src/lib/providers/persona-kyc-provider.ts:29-70; persona-client.ts:30-82; env personaApiKey/ApiVersion/ApiBase/InquiryTemplateVersionId/WebhookSecret; confirmed live sandbox 2026-06-02 | Inquiry with reference-id=phone; one-time link; idempotent creation; raw PII stays on Persona domain. |
| MockKycProvider (B1/dev fallback, single switch point) | ✅ built | src/lib/providers/mock-kyc-provider.ts:9-40; factory kyc-provider.ts:49-60 | Selected when PERSONA_API_KEY unset; returns admin-dashboard review link; staff manually flips kycStatus. |
| KYC state machine (human-review-only invariant — never sets kycStatus) | ✅ built | src/lib/kyc-state-machine.ts:5-72; HUMAN_TERMINAL=['approved','rejected'] 25-35 | Persona events move kycReviewState only; late events ignored after human decision; data-minimized (idLast4/watchlistHit/pepHit/inquiry id). |
| KYC case store (webhook idempotency + append-only audit + human review()) | ✅ built | src/lib/kyc-case-store.ts:32-142; markEventSeen 30d TTL; review() 66-98 sole path to terminal kycStatus; listNeedsReview 128-138 | Only review() sets verified/rejected; append-only audit with timestamp#seq. |
| Verify-before-send gate (isSendVerified predicate, rejects grandfathered) | ✅ built | src/lib/kyc-gate.ts:4-19; used in pay route, cron-run, agent + tools (3 chokepoints: check_send_limit tools.ts:1403, get_quote 629, send_approve_picker 1148) | Only 'verified' may send; grandfathered cannot; separate from tier rules; triple-redundant gate. |
| Register/Login/Reset flows (AAL2 2FA, enumeration-safe, brute-force throttle) | ✅ built | src/app/account/actions.ts:94-287; GENERIC_LOGIN_ERROR; recordLoginFailure/isLoginLocked/clearLoginFailures | Session minted only after OTP consuming single-use pending-auth token; reset does NOT auto-login; phone derived from token not form. |
| Customer auth store (Argon2id + pepper + HIBP, field-encrypted email) | ✅ built | src/lib/customer-auth-store.ts:114-200; password.ts:29-79 (argon2id m=19456,t=2,p=1 + pepper, scrypt fallback); pwned.ts:22-50 (k-anonymity, fail-open) | Lazy scrypt->Argon2id upgrade on login; pepper unversioned (rotation = forced reset). |
| Field-level PII encryption (AES-256-GCM envelope, per-record DEK + wrapped master key) | ✅ built | src/lib/field-crypto.ts:8-191; VERSION v1, iv\|\|tag\|\|ct, EnvKeyProvider from FIELD_ENCRYPTION_KEY | Crypto-shred ready; KMS-shaped wrap/unwrap; self-describing blobs; leaked Redis token yields only ciphertext. |
| Account OTP store (WhatsApp 6-digit, purpose-namespaced, geo allow-list) | ✅ built | src/lib/otp-store.ts:100-191; TTL 300s, MAX_ATTEMPTS 5/code, MAX_FAIL_PER_DAY 10, 30s cooldown, 8-country geo list, timing-safe | login/register/reset namespaced so a login code can't redeem for reset; hash-at-rest; single-use burn. |
| Pending-auth token (AAL2 binding for OTP step, single-use, purpose-scoped) | ✅ built | src/lib/pending-auth-store.ts:6-90; sha256 key, TTL 300s, peek/consume getdel | Minted only after prior factor; derives phone from token; reset token cannot authenticate login (purpose mismatch). |
| Session management (AAL2, 30-min idle / 12-h absolute, hashed token, __Host- cookie) | ✅ built | src/lib/customer-auth-store.ts:312-374; IDLE_MS 30m, ABSOLUTE_MS 12h; cookie src/lib/customer-session-cookie.ts (__Host-sr_session) | Token hash is Redis key; deleteAllSessions revokes on reset; HttpOnly+Secure+SameSite=Lax+Path=/. |
| Password reset (single-use 30-min token, revokes all sessions, no auto-login) | ✅ built | src/lib/customer-auth-store.ts:378-393; account/actions.ts:228-287 | Enumeration-safe; setPassword includes HIBP + breach check; reset OTP can't mint session. |
| Login brute-force throttle (per-phone/day 10, per-IP/hour 50, fail-closed) | ✅ built | src/lib/customer-auth-store.ts:53-58,398-430; account/actions.ts:148-154 | Lock checked before Argon2 verify; per-phone counter survives IP rotation. |
| Onboarding token (single-use, phone-bound deep link) | ✅ built | src/lib/onboarding-token.ts:35-79; consumeOnboardingToken on registerAction | Advisory binding (not security boundary); real possession proof is WhatsApp OTP; mandatory in P3 when bot hands out links. |
| Verify-link issuance (reuse existing non-terminal Persona inquiry) | ✅ built | src/lib/verify-link.ts:35-86 (issueVerifyLink/reusableInquiryId), looksLikeVerifyHandoff 25-28 | Prevents repeated resends from minting new inquiries; never throws (null on failure). |
| Persona webhook handler (idempotency dedupe + state machine + fail-soft notify) | ✅ built | src/app/api/persona-webhook/route.ts:23-75 | HMAC verify 401 -> parse -> markEventSeen -> load by reference-id -> applyKycEvent -> audit -> fast 200 -> after() WhatsApp nudge. |
| Persona webhook parsing (defensive, never throws) | ✅ built | src/lib/providers/persona-webhook-parse.ts:31-65 | Kebab attrs / snake_case fields; extracts eventId/name/inquiryId/referenceId/status/idLast4/watchlistMatched; returns null on unparseable. |
| Persona signature verification (HMAC-SHA256 + ±5min replay guard, dual-secret) | ✅ built | src/lib/providers/persona-signature.ts:29-53; route.ts:24-28; tests/persona-signature.test.ts | Header t=<unix>,v1=<hex>; any v1 match passes (rotation); fail-closed on empty header/secret. |
| KYC status type hierarchy (KycStatus vs KycReviewState separation) | ✅ built | src/lib/types.ts:212-236,248-295 | KycStatus terminal human-only; KycReviewState Persona-driven; grandfathered = T1 for caps but cannot send. |
| Customer account portal routes (/account register/login/reset/verify + home) | ✅ built | src/app/account/ (page.tsx, register/login/reset/verify, verify/actions.ts startVerificationAction); account-forms.tsx | requireCustomer redirects to /account/login; verify page shows done/inReview/start based on status. |
| Transaction OTP store (per-tx + phone-bound, AAL2 step-up) | ✅ built | src/lib/transaction-otp.ts:41-106; TTL 10min, MAX_ATTEMPTS 5, 30s cooldown | Code for one tx can't authorize another; delivered in-session free-form; no logging. |

## Customer portal / auth

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Customer session (separate Redis namespace + __Host- cookie from staff) | ✅ built | src/lib/customer-session-cookie.ts:1-9 (__Host-sr_session); distinct from staff SESSION_COOKIE | Customer and staff sessions entirely separate; __Host- prefix gives browser-level scoping (HTTPS only, Path=/, no Domain). |
| Account home / verify pages gated by requireCustomer | ✅ built | src/app/account/page.tsx, verify/page.tsx (requireCustomer) | Public POST server actions for auth flows; only home + verify pages require login. |
| Customer account portal flow (register -> login -> verify(KYC) -> home) | ✅ built | src/app/account/ structure; actions.ts registerAction/loginAction/verifyOtpAction/resendOtpAction/logoutAction/requestResetAction/resetAction | See KYC & onboarding for the underlying auth-store/OTP/session primitives. |

## Admin dashboard

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Overview dashboard / metrics (commission/volume/transactions/needs-attention) | ✅ built | src/app/admin-dashboard/page.tsx:16-100; src/lib/dashboard.ts:19-69 (summarize) | Pure aggregator helpers compute metrics from transfers. |
| Transactions ledger (search, date range, partner filter, tabs) | ✅ built | src/app/admin-dashboard/transactions/page.tsx:1-87; transactions-explorer.tsx:1-100 | Search by recipient/account-last4/phone; from/to date; partner dropdown. |
| Schedules page (next-due countdown, 7-day alert, active/all toggle) | ✅ built | src/app/admin-dashboard/schedules/page.tsx:1-100; dashboard.ts:85-125 (nextDueAt/schedulesDueInRange) | Due-in-next-7-days section + schedule table. |
| Customers list (tier badges, KYC status, lifetime sent, last activity) | ✅ built | src/app/admin-dashboard/customers/page.tsx:1-100; tier-rules.ts deriveTier | Computes lifetimeByPhone, sorts by recent activity. |
| Customer detail page (identity/KYC, transfers, verify/reject actions) | ✅ built | src/app/admin-dashboard/customers/[phone]/page.tsx:1-120; markCustomerVerifiedAction/markCustomerRejectedAction/reviewKycAction | KYC decision form is human-review terminal path. |
| Customer create form (phone unique, country, partner, KYC status) | ✅ built | src/app/admin-dashboard/customers/new/page.tsx:1-80; createCustomerAction | partnerId selectable only by platform admins; partner-admin pinned to own partner. |
| Compliance dashboard (In Review / Flagged / Blocked tabs + velocity) | ✅ built | src/app/admin-dashboard/compliance/page.tsx:1-100; dashboard.ts:127-143 (topVelocityToday) | Filters by status/complianceStatus. |
| Compliance actions (Release / Reject / Assign / Resend / Cancel) | ✅ built | src/app/admin-dashboard/actions.ts:49-119; src/lib/dashboard-ops.ts:5-76 | Release triggers stage-2 delivery; reject = mock refund + cancel. |
| KYC review queue (pending/needs_review, human decision workflow) | ✅ built | src/app/admin-dashboard/kyc/page.tsx:1-91; getKycCaseStore().listNeedsReview() scope-filtered | Status counts + needs-review queue. |
| Analytics dashboard (Recharts 7/30/90d: daily counts/volume/commission, distributions, top recipients) | ✅ built | src/app/admin-dashboard/analytics/page.tsx:1-100; src/lib/analytics.ts:35-139 | statusDistribution, complianceDistribution, fundingMethodMix, topRecipientsByCount. |
| Analytics charts (BarChart/AreaChart/PieChart via Recharts) | ✅ built | src/app/admin-dashboard/analytics/charts.tsx:1-50 | ResponsiveContainer + COLORS palette. |
| Partners list (countries, status, customer/transfer counts, created) | ✅ built | src/app/admin-dashboard/partners/page.tsx:1-100 | Aggregates counts by partnerId. |
| Partner detail page (info, transfers, staff management) | ✅ built | src/app/admin-dashboard/partners/[id]/page.tsx:1-80; setPartnerStatusAction/updatePartnerAction/createPartnerStaffAction/removePartnerStaffAction | Info + transfers table + staff table. |
| Partner create form (name, countries, brand name, color, logo, note) | ✅ built | src/app/admin-dashboard/partners/new/page.tsx:1-75; createPartnerAction | Platform-admin only. |
| Team page (staff list, inline role/permission edit, suspend/remove) | ✅ built | src/app/admin-dashboard/team/page.tsx:1-100; updateStaffAction/setStaffStatusAction/removeStaffAction | Platform-admin gated; shows lastLoginAt. |
| Team member create form (role, scope, permissions) | ✅ built | src/app/admin-dashboard/team/new/page.tsx:1-90; createStaffAction | Permissions: canCancel/canResend/canAssign/canApproveKyc. |
| Corridors page (corridor-request lead list) | ✅ built | src/app/admin-dashboard/corridors/page.tsx:1-67; listCorridorRequests() | Date/destination/approx amount/sender phone; no per-partner scoping yet. |
| Cmd-K command palette (navigate + quick actions) | ✅ built | src/app/admin-dashboard/command-palette.tsx:1-255; command-items.ts:1-84 | Navigate group + Actions (new customer/teammate/partner, review flagged). |
| Mobile nav drawer (focus trap, Esc-close, scroll-lock) | ✅ built | src/app/admin-dashboard/mobile-nav.tsx:1-80 | DrawerProvider + MobileMenuButton. |
| Desktop sidebar (role-based visibility, active state) | ✅ built | src/app/admin-dashboard/sidebar.tsx:1-49; visibleNavItems(staff) | Account label for platform admins before team. |
| Top bar (brand, Cmd-K, live-refresh indicator, avatar, logout) | ✅ built | src/app/admin-dashboard/top-bar.tsx:1-42 | Includes MobileMenuButton + CommandPalette + LiveRefresh. |
| Live refresh (5s router.refresh() polling) | ✅ built | src/app/admin-dashboard/live-refresh.tsx:1-17 | Default 5000ms interval + live indicator dot. |
| Responsive ExpandableTable (desktop table / mobile collapsible cards) | ✅ built | src/app/admin-dashboard/expandable-table.tsx:1-80 | Primary columns always visible. |
| KYC badge (status pill, in-review, watchlist/PEP flags) | ✅ built | src/app/admin-dashboard/kyc-badge.tsx:1-57 | Watchlist/PEP warning badges. |
| Icon set (26 SVG icons), nav model (nav.ts), layout, format helpers | ✅ built | icons.tsx:1-100; nav.ts:1-84 (visibleNavItems/NAV_META/resolveNavItems); layout.tsx:1-22; admin-dashboard/format; src/lib/mask.ts; masked-destination.tsx | Shared serializable nav for client boundaries. |

## Multi-tenancy & RBAC

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Staff login & session management (Redis, 7-day TTL, secure cookie) | ✅ built | src/app/login/actions.ts:11-54; src/lib/auth-store.ts:45-65; SESSION_COOKIE='sendhome_session' src/lib/session-cookie.ts:3 | randomBytes(32) token; HttpOnly+Secure+SameSite=Lax; middleware gates /admin-dashboard. |
| Seed admin account (idempotent, env-driven, optional partner staff) | ✅ built | src/lib/seed.ts:7-54 | Only seeds when staff table empty; partner record auto-created if missing. |
| RBAC roles (admin/agent) + fine-grained permissions (canCancel/canResend/canAssign) | ✅ built | src/lib/types.ts:126-137; src/lib/permissions.ts:3-9 (hasPermission); actions.ts:19-27 (requirePermission) | Admin bypasses permission checks; each server action enforces its specific permission. |
| Platform admin vs partner-scoped staff (Scope type, scopeOf) | ✅ built | src/lib/auth.ts:42-50 (requirePlatformAdmin); staff-scope.ts:1-23 (scopeOf, empty-string escalation guard) | Platform admin = role='admin' + partnerId undefined; partner admin = admin + partnerId. |
| Multi-tenant scoping (canSee + ScopedStore on every read/write) | ✅ built | src/lib/staff-scope.ts:21-23 (canSee); scoped-store.ts:19-72; actions.ts:39-47 (getScopedTransfer) | canSee is the tenant boundary; getScopedTransfer pattern resolves + checks scope before mutate (generic 'not found' if out-of-scope). |
| Session revocation & suspended-staff lockout (mid-session re-check) | ✅ built | src/lib/auth-store.ts:56-65; auth.ts:9-28 (getCurrentStaff re-reads + checks status==='suspended'); team/actions.ts:149-179 | Suspend sets status + deleteAllSessionsFor; stale cookie can't bypass; recordLogin gated for suspended. |
| Suspended-partner bounce (cascade session revoke) | ✅ built | src/lib/auth.ts:22-26; partners/actions.ts:68-89 | Suspending partner deletes all affected staff sessions; generic error avoids existence disclosure. |
| Server-action security checklist (own gate, scope, collision, identity-over-form) | ✅ built | admin-dashboard/actions.ts; team/actions.ts; partners/actions.ts; customers/actions.ts (all server actions) | Every action: own require* gate, validate input, collision check before write, canSee scope, identity overrides form fields. |
| Audit log for staff mutations (append-only, capped 200) | ✅ built | src/lib/audit-log-store.ts:1-64; team/actions.ts:44-57,104,144,177,201 | created/updated/suspended/reactivated/removed. Partner-staff CRUD NOT yet audit-logged — only platform team actions are. |
| Cross-tenant data isolation (transfers, customers, schedules) | ✅ built | admin-dashboard/actions.ts:39-47; customers/actions.ts:19-173; scoped-store.ts:54-68 | H3 fix: global customer key needs scope check; out-of-scope returns generic 'Customer not found'. |
| Platform-admin protections (no self-lock / last-admin guard) | ✅ built | team/actions.ts:36-42 (isActivePlatformAdmin/countActivePlatformAdmins), 128-135, 161-170, 162-164/189-191 | Reject demote/suspend/remove if count<=1; ban self-suspend/self-remove. |
| Partner scope validation on create (partner exists, no empty-string escalation) | ✅ built | team/actions.ts:80-86; partners/actions.ts:91-128 | createPartnerStaffAction takes partnerId from URL not form; dual-validates existence. |
| Partner-admin CRUD limitations (M3/M4/M5 design decisions) | ✅ built | partners/actions.ts:13-15 (create platform-only), 41-66 (update own branding via canSee), 68-89 (status platform-only), 130-146 (removePartnerStaff rejects platform staff) | Partner-admin edits own branding only; cannot create/suspend/manage rival partners. |
| Username collision guard (saveStaff is unconditional SET) | ✅ built | team/actions.ts:88-91; partners/actions.ts:113-116 | getStaff collision check before create prevents silent overwrite/hijack. |
| Middleware page-level gating (/admin-dashboard requires session cookie) | ✅ built | src/middleware.ts:1-16 | Layered defense: page redirect + endpoint require* gates. |
| Suspended status fields (StaffStatus / PartnerStatus, reversible) | ✅ built | src/lib/types.ts:131 (StaffStatus), 355 (PartnerStatus) | Absent defaults to active (lazy, no migration); suspend preserves record + audit history. |
| Login error messages (no credential/username enumeration) | ✅ built | src/app/login/actions.ts:19-33 | All failure paths return generic 'Invalid...' / 'Account unavailable'. |
| lastLoginAt signal (fresh re-read on record) | ✅ built | src/lib/auth-store.ts:37-44; login/actions.ts:36 | Set after password verify + status check; defense-in-depth vs stale SET race; shown on Team page. |
| No cross-partner assignment (M2) | ✅ built | admin-dashboard/actions.ts:71-74 | Assignee scope must canSee transfer.partnerId, else reject. |
| Multi-tenant partner boundary field (partnerId on Customer/Transfer/Schedule/Staff, lazy backfill) | ✅ built | src/lib/transfer-create.ts:29,110; types.ts:353,273,121,55,146; schedule-store.ts:19-26; /api/cron backfill migrations | DEFAULT_PARTNER_ID='default'; P2 established field, P3/P5 enforce scoping; cron lazily backfills legacy records. |

## Scheduling & cron

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Recurring schedules CRUD (create/list/cancel/get, weekly/monthly, endDate) | ✅ built | src/lib/schedule-store.ts:10-44; tools.ts:273-326 (create/list/cancel_schedule) | Lazy-fills partnerId + sourceCurrency/amountSource from pre-P4 records on read. |
| Schedule due evaluation (isScheduleDueToday, monthly dayOfMonth / weekly dayOfWeek, Eastern time) | ✅ built | src/lib/schedule.ts:4-16 | Same-day lastRunAt skip; Eastern boundary avoids double-firing in one UTC day. |
| Daily cron fires due schedules (createTransfer, lastRunAt update, endDate expiry) | ✅ built | src/lib/cron-run.ts:34-94; /api/cron/route.ts:27-116; vercel.json '0 13 * * *' | Daily 13:00 UTC; maxDuration 300s; runs 8 idempotent backfills before firing; CRON_SECRET bearer auth (fail-closed 401 if set). |
| Cron gating (skip opted-out + unverified senders without firing or bumping lastRunAt) | ✅ built | src/lib/cron-run.ts:54-70; isSendVerified gate + sendScheduledSkipped kycUrl nudge | Schedule stays active to resume once customer re-subscribes/verifies; fail-soft. |
| Cron does NOT screen sender's legal name (senderName omitted) | ✅ built | src/lib/cron-run.ts:70-81 (no senderName); compliance.ts:36-38 undefined senderName -> {matched:false} | Only recipient sanctions-screened in cron path; senderName optional in CreateTransferInput. Flagged as a known gap to re-verify. |
| create_schedule / list_schedules / cancel_schedule tools | ✅ built | src/lib/tools.ts:273-306 (create), 309-314 (list), 318-326 (cancel), 932-1025 (impl) | Monthly day 1-28 / weekly day 0-6; ownership-filtered by sender phone; each run still requires model approval card. |
| Saved recipients upsert + list (sort by lastUsedAt, masked on display) | ✅ built | src/lib/store.ts:145-170; tools.ts list_saved_recipients/resolve_recipient (1027-1089) mask via maskAccount | Stored per senderPhone hash; LLM never sees raw account numbers. |
| Corridor-request lead capture (unsupported destination, optional amount/currency) | ✅ built | src/lib/tools.ts:1375-1392 (captureCorridorRequestTool); types.ts:391-398; store.ts:181-190 | Model must state limitation + list 8 countries first (prompt-enforced); destination stored as free text. |
| Draft store (30-min TTL, active_draft pointer, atomic consume) | ✅ built | src/lib/draft-store.ts:10-39; types.ts:159-193 | recipient_draft:{id} + active_draft:{phone} both ex 1800s; payoutDestination filled at pay time. |

## Bot tools (transfer lifecycle)

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| check_send_limit tool (verify gate + caps + tiers + EDD + KYC URL) | ✅ built | src/lib/tools.ts:412-430 (schema), 1394-1441; verify gate first (1403), evaluateCap/evaluateEdd | First gate per prompt; pass amount 0 for status-only; mints fresh KYC URL for T0/Suspended. |
| validate_phone tool (recipient WhatsApp number format) | ✅ built | src/lib/tools.ts:435-448 (schema), 1362-1373; isValidPhone 10-15 digits | Pure function; returns valid/normalized/error. |
| send_recipient_picker tool (interactive buttons, max 2 + 'Someone new') | ✅ built | src/lib/tools.ts:338-361 (schema), 1091-1122 (sendInteractive) | Sets interactiveSent=true; labels disambiguated on duplicate names. |
| resolve_recipient tool (exact/ambiguous/none, masked payout) | ✅ built | src/lib/tools.ts:452-463 (schema), 1048-1089; searches up to 25 recipients; maskAccount | Resolves typed name to exact/ambiguous/none; LLM never sees raw account. |
| list_saved_recipients tool (top 2 recent) | ✅ built | src/lib/tools.ts:330-335 (schema), 1027-1046 | Top 2 by recency for quick-pick on greeting; fails gracefully to []. |
| create_transfer tool (button-tap + legacy paths, triple gate) | ✅ built | src/lib/tools.ts:182-224 (schema), 712-865; verify+cap+compliance gates 736/741/806/813 | Button-tap consumes draftId; legacy explicit args for cron/cold-start; records daily/monthly volume. |
| send_approve_picker tool (lock quote + draft + compliance + Approve&Pay card) | ✅ built | src/lib/tools.ts:365-398 (schema), 1124-1267; buildApproveSummary, sendCtaUrl | Verify gate 1148, cap 1156, compliance 1179; no bank details collected in chat; sets interactiveSent=true. |
| generate_payment_link tool (standalone link fallback) | ✅ built | src/lib/tools.ts:228-237 (schema), 884-896 | Not used in normal flow; checks transfer exists + not blocked. |
| cancel_draft tool (abandon pending approval) | ✅ built | src/lib/tools.ts:403-407 (schema), 1341-1360 | Consumes draft from buttonTap.cancel or active-draft pointer; graceful if none. |
| repeat_transfer tool (re-send, reuse payout + amount, EDD-aware) | ✅ built | src/lib/tools.ts:467-480 (schema), 1269-1339; routes through send_approve_picker | Reuses last amount/funding; returns needs_edd=true when EDD profile missing. |
| check_payment_status tool (transfer status query) | ✅ built | src/lib/tools.ts:240-249 (schema), 898-905 | Simple status lookup. |
| update_recipient_phone tool (retro-fix recipient number) | ✅ built | src/lib/tools.ts:253-269 (schema), 907-930 | Validates + updates transfer.recipientPhone; never claims retroactive fix to user. |
| capture_corridor_request tool (unsupported-destination lead capture) | ✅ built | src/lib/tools.ts:483-506 (schema), 1375-1392 | Prompt-enforced precondition: state limitation + list 8 countries first. |

## Provider seams & integrations

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| PaymentProvider pluggable seam (initiateTransfer/getStatus/handleWebhook, factory) | ✅ built | src/lib/providers/payment-provider.ts:51-59 (interface), 109-111 (getPaymentProvider); env.paymentProviderMode always 'mock' in v1 | Only MockPaymentProvider implemented; real provider hook ready; pay route call at route.ts:49. |
| KycProvider pluggable seam (startVerification/getStatus/handleWebhook, factory) | ✅ built | src/lib/providers/kyc-provider.ts:27-42,49-60 | MockKycProvider vs PersonaKycProvider; factory selects on personaApiKey presence; whatsapp route call at route.ts:186. |
| SanctionsScreener pluggable seam (screen, factory) | ✅ built | src/lib/providers/sanctions-provider.ts:16-18,40-42 | MockSanctionsScreener only impl; real (ComplyAdvantage/Sanctions.io) swappable without call-site change. |
| Payment webhook signature verification (HMAC-SHA256, fail-closed, timing-safe) | ✅ built | src/lib/providers/payment-webhook-verify.ts; route src/app/api/payment-webhook/[provider]/route.ts:19-25; tests/payment-webhook-verify.test.ts | Mock skips; real verifies x-signature; empty secret/signature -> false. |
| Payment webhook route (per-provider HMAC, idempotency, stage-2 after()) | ✅ built | src/app/api/payment-webhook/[provider]/route.ts:11-61; tests/payment-webhook-route.test.ts | Raw body first; unparseable -> 200 ignored; updateTransferFromWebhook handles repeats. |
| Persona client (REST: createInquiry/getInquiry/generateOneTimeLink) | ✅ built | src/lib/providers/persona-client.ts:30-82; base https://api.withpersona.com/api/v1, version 2025-12-08, Idempotency-Key; confirmed sandbox 2026-06-02 | Injected fetchImpl for testability; tests/persona-kyc-provider.test.ts. |
| Meta webhook signature verification (X-Hub-Signature-256) | ✅ built | src/lib/providers/meta-signature-verify.ts:17-28; whatsapp route 52-56; tests/meta-signature-verify.test.ts | Delegates to verifyWebhookSignature; fail-closed when secret set; warns if unset (current prod). |
| Factory pattern (zero call-site coupling for provider swaps) | ✅ built | payment-provider.ts:109-111; kyc-provider.ts:49-60; sanctions-provider.ts:40-42 | Single switch points selected by env vars; call sites unchanged when real providers land. |
| Webhook idempotency + dedup | ✅ built | persona-webhook/route.ts:42-45 (markEventSeen); payment-webhook-route.ts:35-37 | Persona dedupes by event id; payment relies on updateTransferFromWebhook (status-at-target -> no re-fire). |
| Fail-soft async notifications (after() strategy) | ✅ built | payment-provider.ts:70-84; payment-webhook-route.ts:42-59; persona-webhook-route.ts:62-72 | Stage-2 WhatsApp sends in after(); fast 2xx; all catch+log, never fail HTTP response. |
| Provider seam test coverage (Vitest) | ✅ built | tests/payment-provider.test.ts, kyc-provider.test.ts, payment-webhook-verify.test.ts, persona-signature.test.ts, persona-webhook-parse.test.ts, payment-webhook-route.test.ts, persona-webhook-route.test.ts, sanctions-provider.test.ts | Timing-safe, fail-closed, tamper detection, replay guard, route request/response cycles; all run in CI. |

## Config & CI/CD

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Environment variables: required (throws at import if missing) | ✅ built | src/lib/env.ts:3-9,13-29 | OLLAMA_*, WHATSAPP_*, KV_REST_API_*, SEED_ADMIN_USERNAME/PASSWORD; missing any throws (no silent fallback). |
| Environment variables: optional Persona KYC (Phase 2) | ✅ built | src/lib/env.ts:106-138 | PERSONA_API_KEY ('' -> MockKycProvider), PERSONA_ENVIRONMENT/WEBHOOK_SECRET/INQUIRY_TEMPLATE_VERSION_ID/API_VERSION/API_BASE; KYC template names defaulted. |
| Environment variables: optional payment/Meta/partner-seed/cron | ✅ built | src/lib/env.ts:30-35,62-74,139-143 | META_APP_SECRET ('' skips verify, warns), PAYMENT_PROVIDER_MODE (always mock v1), PAYMENT_WEBHOOK_SECRET_<PROVIDER>, WHATSAPP_FLOWS_ENABLED (default false), SEED_PARTNER_*, CRON_SECRET ('' public). |
| Environment variables: optional app/crypto/OTP/password | ✅ built | src/lib/env.ts:36-98 | APP_BASE_URL (self-derives from VERCEL_PROJECT_PRODUCTION_URL), FIELD_ENCRYPTION_KEY ('' -> no encryption), PASSWORD_PEPPER ('' -> scrypt), OTP_DEV_MODE, WHATSAPP_AUTH_TEMPLATE. |
| CI pipeline (GitHub Actions: typecheck/lint/test/build) | ✅ built | .github/workflows/ci.yml; on push to main + PR; Node 24; concurrency cancel-in-progress; 10-min timeout | Branch protection on main requires ci/ci status check; direct pushes rejected. |
| CI scripts (package.json) | ✅ built | package.json ~13-21 | typecheck tsc --noEmit, lint eslint --max-warnings 0, test vitest run --passWithNoTests, e2e playwright, build next build. |
| Smoke test (Playwright E2E on prod after deploy) | ✅ built | .github/workflows/smoke.yml; on deployment_status success Production | BASE_URL canonical alias bypasses Vercel protection; uploads trace on failure (7 days). |
| Vercel cron schedule (daily 13:00 UTC GET /api/cron, idempotent backfills) | ✅ built | vercel.json:2-7; src/app/api/cron/route.ts:27-116 | 8 backfill migrations (customers/country-currency/partners/schedules/source-amounts/corridor-compliance/expand-countries/all-corridors) then runDueSchedules; maxDuration 300s. |
| Pay route provider integration (getPaymentProvider entry point) | ✅ built | src/app/api/pay/[transferId]/route.ts:3,49 | initiateTransfer begins settlement; mock advances both stages; real provider returns providerRef. |
| WhatsApp route KYC integration (getKycProvider entry point) | ✅ built | src/app/api/whatsapp/route.ts:21,186 | startVerification issues KYC link; fail-soft skip if already pending/verified. |
