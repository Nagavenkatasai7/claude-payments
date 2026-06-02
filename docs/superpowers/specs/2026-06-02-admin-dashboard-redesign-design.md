# Admin Dashboard Redesign — Design Spec

**Date:** 2026-06-02
**Status:** Draft (research-pending sections marked ⏳)
**Author:** autonomous overnight build (user asleep; scoping answered before sleep)

## Goal

Rebuild the SmartRemit admin dashboard to be (1) genuinely **flexible across laptop + phone**,
(2) **easier to use / less confusing**, (3) a home for **full teammate management**, and
(4) **hardened** against the security loopholes an audit surfaces. Benchmarked against
professional dashboards (Stripe, Linear, Vercel, WorkOS, Mercury, Ramp).

## Locked decisions (from the user, before sleep)

1. **Bold visual refresh** — new design-token system, restyled cards/tables/charts, a command
   bar, tighter responsive grid. **Same pages + same routes.**
2. **Full team management** — invite/create/edit/suspend/remove teammates + role + partner-scope
   + permission assignment, behind the mandatory server-action security checklist.
3. **Fix confident, flag risky** — fix loopholes I'm sure of (with tests); write up risky /
   behavior-changing ones for morning review instead of silently changing them.
4. **PR ready, do NOT deploy** — verify green (lint + typecheck + tests + build) + adversarial
   review + a writeup; the user says "deploy" when happy.

## Non-goals / out of scope

- No route changes, no page removal/merge (the user chose "same pages + nav", not "reorg nav").
- No new external dependencies (no Three.js, no component library). Pure CSS + inline SVG, same
  as the rest of the repo.
- No money-core changes (fx/quote/payment/transfer-create) — this is dashboard + auth/staff only.
- Customer-facing surfaces (landing `.lp`, pay `.payapp`, the WhatsApp bot) are untouched.
- `sh-*` CSS namespace is **kept** (725 usages, deliberate user choice). We refresh by evolving
  token *values* + restyling component classes + adding new classes — **never renaming** classes.
- Real email-invite infrastructure is out (no SMTP). "Invite" = create-with-credentials (the repo
  is password-based today). Flagged for the user.

## Strategy: refresh via tokens + components, not class renames

The `sh-*` theme already uses CSS custom properties (`--sh-*`). The bold refresh is delivered by:
- **Evolving the token system** — a fuller neutral ramp, refined accent, a real 4px-based spacing
  scale, a type scale, layered elevation tokens, focus-ring token, fluid `clamp()` for type/space.
  Keep existing `--sh-*` names so all pages inherit the new look automatically; add new tokens.
- **Restyling component classes in place** — `.sh-card`, `.sh-table`, `.sh-metric`, `.sh-pill`,
  `.sh-btn-*`, topbar/sidebar — same class names, modernized rules.
- **Adding new classes** for new components (command palette, icon, segmented control, toolbar,
  status dot, skeleton, empty-state illustration) — all `sh-*`-prefixed, collision-checked against
  the existing catalogue.

Because class names are stable, the 28 pages refresh largely for free; the fan-out is per-page
polish (SVG icons, applying new helpers, responsive correctness), not a rewrite. This is the
lowest-risk path to a bold look for an unattended overnight build.

## Visual design system ⏳ (token values finalized from research)

Direction (values refined by `research:dashboards-visual`):
- **Color:** keep the Stripe-ish indigo accent but modernize the neutral ramp (true gray scale
  `--sh-gray-50..900`), crisper borders, layered surfaces (app bg < card < elevated). Semantic
  success/warning/danger/info with calmer, accessible (WCAG AA) fg/bg pairs. Money uses
  `font-variant-numeric: tabular-nums` everywhere.
- **Type:** system stack (already) + a tightened scale: page-title, section, body, caption,
  table-cell, numeric. Tabular figures for all amounts/IDs.
- **Spacing/radius/shadow:** 4px base scale; card radius slightly larger; subtle layered shadows
  used sparingly (borders-first elevation, Stripe/Linear style).
- **Density:** denser but scannable tables (row height, sticky header, hover, right-aligned
  numerics with tabular figures), refined empty states.

## Icon system (SVG, cross-OS)

Replace OS-variant glyphs/emoji with a single inline-SVG icon set (monochrome, `currentColor`,
`aria-hidden`), mirroring the customer-surface approach in PR #35. Surface:
- `nav.ts` `NAV_META.icon` glyphs (◾↔↻◍◆⚑▦↗◉) → named SVG icons.
- `top-bar.tsx` `🔍` search glyph; `sidebar.tsx` `⚙` Settings; `mobile-nav.tsx` `✕` close +
  hamburger; any `⚠ / 📅` alert glyphs in pages.
- A small `icons.tsx` module exporting typed icon components; `nav.ts` switches `icon: string` →
  an icon key (`IconName`) so it stays a plain serializable module (no JSX in the shared nav model
  that the client drawer imports — pass a key, resolve to SVG in each renderer).

## Command palette (Cmd-K) ⏳ (a11y pattern from research)

Turn the decorative top-bar search into a real **Cmd-K / Ctrl-K command palette** (client island):
- Full WAI-ARIA combobox + listbox + dialog pattern (role, `aria-activedescendant` or roving
  tabindex, focus trap, Esc, keyboard nav, SR announcements) — per `research:responsive-a11y`.
- Indexes: nav destinations + quick actions (e.g. "Add teammate", "View flagged", "Search
  transactions"). Data source is the resolved nav + a static action list (no new server calls in
  v1; navigations via `router.push`). Free-text routes to transactions search.
- Opens via Cmd/Ctrl-K and by clicking the (now real) search field. Visible affordance + `⌘K` hint.

## Responsive strategy (laptop + phone)

- Keep the proven #35 structure (desktop sidebar hidden ≤1024 + accessible drawer; ExpandableTable;
  auto-fit metric/chart grids; 16px inputs; 44px targets; reduced-motion).
- Add **fluid laptop behavior** (1024–1440): content max-width + fluid gutters, `clamp()` type and
  spacing, so it doesn't look stretched/cramped at common laptop widths.
- Audit each page for horizontal-scroll / overflow at 1280/1024/768/390 widths; ensure every table
  uses ExpandableTable (or `.sh-ledger-wrap`), every form stacks, every toolbar wraps.

## Full team management feature

### Data model
- Add to `Staff` (types.ts): `status?: 'active' | 'suspended'` (optional; **lazy-fill default
  'active'** on read — no migration), and `lastLoginAt?: string` (set in the login action; cheap,
  one write per login).
- Reuse `Partner` for the scope picker. Roles stay `'admin' | 'agent'`. "Scope" = no partnerId
  (platform) vs a partnerId (that partner). This is the existing model, surfaced in the UI.

### Pages (same `/admin-dashboard/team` route)
- **Team list** (redesigned): columns Name · Username · Role · Scope (Platform / partner name) ·
  Permissions · Status · Last active · Actions. Search + role/scope/status filters. Pending/empty
  states. Mobile via ExpandableTable. Shows **all** staff (platform + partner), not just platform.
- **Create teammate** `/admin-dashboard/team/new`: name, username, password, role (admin/agent),
  scope (Platform or pick a Partner), permissions (for agent). Mirrors `customers/new` styling.
- **Edit teammate** inline + a detail affordance: change role, permissions, scope; suspend/
  reactivate; remove.

### Server actions (mandatory security checklist on EACH)
All gated `requirePlatformAdmin` (only the top admin manages staff — keeps the privilege model
clean; partner-admins managing their own team is **flagged as a future enhancement**, not built
overnight, to avoid a risky cross-tenant write path).
- `createStaffAction` — gate; validate name/username/password; **collision check before save**;
  if scoped, **verify the partner exists + is active**; role/scope from validated fields.
- `updateStaffAction` (role/permissions/scope) — gate; load target; if assigning a partner scope,
  verify the partner; **guard: cannot demote/duplicate-escalate**, cannot edit self into lockout.
- `setStaffStatusAction` (suspend/reactivate) — gate; load target; **on suspend revoke sessions**
  (`deleteAllSessionsFor`) mirroring partner-suspend; **cannot suspend yourself**; **cannot suspend
  the last active platform admin**.
- `removeStaffAction` (hardened) — gate; load target; **cannot remove yourself**; **cannot remove
  the last active platform admin**; revoke sessions on remove.
- `auth.ts`: `getCurrentStaff` must also bounce a **suspended staff** mid-session (today it only
  bounces suspended *partners*). Add `if (staff.status === 'suspended') return null;`.

### Guardrails (invariants)
- Never lock out the platform: at least one active platform admin must remain.
- Never act on yourself destructively (suspend/remove/demote-last-admin).
- Suspend ⇒ immediate session revocation (can't keep an open tab alive).
- `scopeOf` empty-string guard already exists — keep it; create/update never write `partnerId:''`.

## Security hardening ⏳ (loophole list from `audit:security`)

Posture: **fix confident, flag risky.** Known/likely targets to confirm + fix:
- Team actions scope-confusion (see above) — fixed by the team redesign.
- Suspended-staff mid-session bounce (auth.ts) — fix.
- Every admin-dashboard server action re-checked against the 4-point checklist (own gate, entity
  exists+in scope, collision-before-create, route-authoritative ownership).
- Partner-scope isolation: confirm no read/write path trusts a form `partnerId`.
- Session cookie flags (httpOnly/secure/sameSite) at the set site (login action) — verify/fix.
- Middleware gaps (only gates pages; API routes self-gate) — document; fix if a real hole.
Findings that are risky/behavior-changing → written up in the PR for morning review, not silently
changed.

## Testing strategy

- TDD the new/changed **logic**: team actions (collision, partner-exists, last-admin guard,
  self-action guard, suspend-revokes-sessions), the `status` lazy-fill, suspended-staff bounce,
  any security fix. Pure helpers (nav icon resolution, command-palette index builder) unit-tested.
- UI/pages remain non-unit-tested (repo convention) but covered by the existing Playwright smoke;
  extend smoke to assert the team page + create-teammate render.
- Keep the suite green (893 → +N). `rm -rf .next` before integration typecheck (iCloud dup gotcha).

## Execution plan (investigate → reference → fan-out → verify → review)

1. ✅ **Scope** (AskUserQuestion — 4 decisions locked).
2. ✅ **Investigate/research** (background workflow: inventory + CSS map + auth model + security
   audit + 3 deep-research agents).
3. **Foundation (controller):** new token system + restyled core components + icon module +
   command palette + responsive helpers, in `globals.css` + shared components. Add `Staff.status`
   + lazy-fill + suspended bounce + login `lastLoginAt`. Commit checkpoint, verify green.
4. **Reference (controller):** convert ONE page (Overview) + build the full **Team** feature as the
   golden example. Verify build, commit, capture diff.
5. **Fan-out (workflow):** one agent per page/bundle (transactions, schedules, compliance,
   analytics, customers, partners, corridors) — apply the refreshed patterns + SVG icons +
   responsive correctness, using the reference diff + a shared preamble. eslint only (not tsc).
6. **Integrate + verify (controller):** `rm -rf .next` → lint + typecheck + test + build. Commit.
7. **Adversarial review (workflow):** one reviewer per area (visual/CSS collisions, team-feature
   security, a11y/command-palette, responsive, ExpandableTable column/cell parity). Fix real
   findings, re-verify.
8. **PR ready (no deploy):** open PR with a thorough writeup incl. the flagged-risky security items.

## Flagged for the user (decisions I defaulted)

- Team management is **platform-admin-only**; partner-admins managing their own team is deferred
  (would add a cross-tenant write path — wanted your sign-off first).
- "Invite" = **create-with-credentials** (no email infra in the repo). If you want real email
  invites, that's a follow-up needing an SMTP/provider integration.
- `lastLoginAt` added (cheap) for an "active" signal; no per-request "last seen" (would write on
  every request).
- Nav stays the same 9 items in the same order (you chose "same pages + nav").

---

## Research-finalized decisions (2026-06-02, post-investigation)

### Token system (from `research:dashboards-visual` — Radix-grounded)
Evolve `--sh-*` values toward a Radix light-mode system; **keep all class names**. Adopt:
- **Neutral:** Slate ramp `--sh-gray-1..12` (`#fcfcfd #f9f9fb #f0f0f3 #e8e8ec #e0e1e6 #d9d9e0
  #cdced6 #b9bbc6 #8b8d98 #80838d #60646c #1c2024`). Re-ground existing `--sh-text`→slate-12
  `#1c2024`, `--sh-text-secondary`→slate-11 `#60646c`, `--sh-border`→slate-4 `#e8e8ec`,
  `--sh-divider`→slate-3 `#f0f0f3`, `--sh-bg`→slate-2 `#f9f9fb`.
- **Accent:** keep an indigo accent (move `--sh-primary` `#635bff`→`#5b51f4`-ish refined indigo;
  add `--sh-primary-12` text + `--sh-accent-bg`). Borders-over-shadows; shadows only float.
- **Semantics:** Radix success/warning/danger/info ramps (3 bg / 6 border / 9 dot / 11 text).
  Note amber text must be `#ab6400` (amber-11) for AA — fixes today's `--sh-warning #7a5a00`.
- **Type:** add a scale (`--sh-text-display/h1/h2/h3/body/label/caption/overline`) with negative
  heading tracking; **`tabular-nums` on every numeric cell** (extend `.sh-amount`, add `.sh-num`).
- **Spacing/radius/shadow:** 4px `--sh-space-1..11`; radius xs4/sm6/md8/lg12/xl16/full; shadow
  xs/sm/md/lg/xl/focus (float-only). Card radius 8px, control radius 6px.
- **Tables:** denser (48px rows), sticky header, hairline dividers, right-aligned tabular numerics,
  row hover. Wrap in `role="region"` + `tabindex=0` + `aria-labelledby` scroll pattern (a11y).
- **Layout:** sidebar 240px (was 220), topbar 56px, content max-width ~1280px + fluid gutters,
  `clamp()` (rem-bounded, ≤2.5× min/max for WCAG 1.4.4).

### Command palette (from `research:responsive-a11y`)
Combobox(role) input whose popup is `role="listbox"`, inside a `role="dialog" aria-modal` (prefer
native `<dialog>` for free focus-trap/Esc/`::backdrop`). **`aria-activedescendant` model** (DOM
focus stays on input; AT focus moves through options; manual `scrollIntoView({block:'nearest'})`).
Open via Cmd/Ctrl-K **and** the visible top-bar search button (`aria-keyshortcuts`). Esc closes +
returns focus to trigger. `aria-live="polite"` result-count region (the APG gap), debounced. 16px
input. Index = nav destinations + quick actions ("Add teammate", "Flagged transfers", "New
partner", "New customer"); free text → transactions search. Client-only `router.push`, no new
server calls in v1.

### Team management (from `research:team-mgmt-ux`)
- **One members list**, server-filtered by scope. Platform-admin: all staff + **Partner column** +
  Partner filter. Columns: Name · Username · Role · Scope/Partner · Status · Last active · Actions.
- **Create-with-credentials** (no email/pending state): username + password + role (+ Partner
  selector revealed only when role = partner-scoped) → **Active immediately**. Collision-guarded.
- **Two presets** (admin/agent) × scope (platform/partner) — no permission matrix; keep the 3
  permission toggles for agents.
- **Suspend (reversible, audit-preserving) is the primary destructive-ish action**; **Remove** is a
  separate, more-guarded action. New `Staff.status:'active'|'suspended'` (lazy-fill 'active').
- **Guardrails:** can't remove/suspend/demote the **last active platform admin**; can't act
  destructively on **yourself** ("(You)" marker); suspend ⇒ revoke sessions; collision-guard create.
- **Build scope:** platform-admin manages ALL staff (incl. per-partner, with scope assignment).
  Partner-admins self-managing their own team = **edge-scoped role** ideal per research, but
  **deferred** (new write surface; flagged) — keeps the overnight build's privilege model clean.
- **Audit log:** record every staff mutation (actor, target, action, timestamp) — new lightweight
  `audit-log-store` (Redis list), shown read-only on the team page; gated platform-admin.

### Security fixes — confident (FIX with tests)
- **H1** cancel/assign/resend → resolve transfer via `createScopedStore(staff).getTransfer(id)`,
  reject out-of-scope before mutating. Push scope into `dashboard-ops` so the unsafe call is gone.
- **H2** release/reject → same scoped lookup before the money-movement primitive.
- **H3** customer KYC verify/reject → `createScopedStore(staff).getCustomer(phone)` (was unscoped).
- **M2** assignee must share the transfer's partner (or actor platform-scoped).
- **M3** `removePartnerStaffAction` → mirror team guard: target must be partner-scoped + match the
  route `partnerId`; never delete a platform admin via the partner endpoint.
- **M5** `createPartnerAction` → re-tier to `requirePlatformAdmin`.
- **M4 (canSee part)** `updatePartnerAction`/`setPartnerStatusAction` → add `canSee` so a
  partner-admin can only touch their OWN partner (closes cross-tenant); FLAG the tiering question.
- **L3** cap `assignTransferAction.note` + `markCustomerRejectedAction.reason` lengths.
- **(my finding)** `getCurrentStaff` bounces **suspended staff** mid-session (today only suspended
  partners). Login refuses suspended staff with the generic message.

### Security findings — FLAG for morning (risky / behavior-changing, NOT changed overnight)
- **H4** `__Host-` cookie prefix / cookie rename → would force-log-out all staff (same reason
  `sendhome_session` was kept on rebrand). Needs a planned rotation.
- **M4 (tiering)** should partner-admins be able to suspend/edit their own partner at all, or is
  that platform-only? (I close the cross-tenant hole; the policy question is yours.)
- **M1** middleware doesn't gate `/api` (all `/api` routes self-gate today) — future-proofing.
- **L1** scrypt cost (N=2^14) — raising it needs a hash-versioning migration (else lockout).
- **L2** create-customer error messages distinguish phone/partner existence (admin-only enum).
