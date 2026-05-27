# P3: Per-partner Sub-Admin Auth — Design

**Date:** 2026-05-27
**Sub-project:** 3 of 5 in SendHome's platform reshape
**Depends on:** P2 (Partner entity + `Staff.partnerId` field)
**Unblocks:** none (P4 and P5 are independent)

## Goal

Let partner staff log in to the dashboard scoped to only their own partner's data, while existing platform admins continue to see everything. Zero customer-facing change — the WhatsApp bot and webhook are untouched.

## Why now

P2 added the `Partner` Redis record + `partnerId` on `Customer`/`Transfer`/`Staff` (optional), with all existing records grandfathered into a "Default Partner." P2 explicitly deferred enforcement: any logged-in admin still sees all data across all partners. P3 closes that gap.

## Non-goals

- **Partner-admin self-service for staff management.** Only platform admins can create/remove partner staff. Self-service can land in P5+ if partners request it.
- **Bot-side scoping.** The customer never sees partner concepts; the bot stays partner-blind (the P2 hard-rule test `tests/bot-content-guard.test.ts` still applies).
- **Multi-corridor scoping.** A partner staff sees all of their partner's data regardless of country/corridor. Per-corridor splits land in P5.
- **Read-only partner-staff view of a suspended partner.** Suspended = total block (login refused, sessions revoked).

---

## 1. Architecture overview

### Role × scope

`StaffRole` stays `'admin' | 'agent'`. No new role names introduced.

`Staff.partnerId` (already optional from P2) becomes the scope signal:

- `partnerId === undefined` → **platform-wide** (legacy behavior; what every existing staff record is)
- `partnerId === 'foo'` → **scoped to partner `foo`** (only sees foo's customers, transfers, etc.)

Four effective personas:

| Persona | `role` | `partnerId` | Sees |
|---|---|---|---|
| Platform admin | `admin` | `undefined` | All data across all partners; can CRUD partners and partner-staff |
| Platform agent | `agent` | `undefined` | All data, but no admin actions |
| Partner admin | `admin` | `'foo'` | foo's data only; can run admin actions for foo |
| Partner agent | `agent` | `'foo'` | foo's data only; no admin actions |

### Enforcement chokepoint

A new `createScopedStore(staff)` returns a `Store`-shaped facade whose list methods auto-filter by `staff.partnerId` (no-op for platform staff). Every dashboard page swaps `getStore()` → `createScopedStore(staff)`. By construction, there is no way for a page to leak data from another partner — the raw `getStore()` is reserved for API routes, cron, and the WhatsApp webhook (which never read on behalf of a logged-in user).

### Migration

Staff: no data migration. All existing staff already have `partnerId: undefined` → they are platform admins by definition.

Schedule: one new sentinel-guarded backfill (`backfillSchedulesOnce`) added to the cron sweep, mirroring B1/P1/P2's pattern. It walks all schedules, calls `getSchedule` (which lazy-fills `partnerId` from the customer), and re-saves to persist. Idempotent; gated by the `schedule-partner-backfill-v1` sentinel.

---

## 2. Type changes and new modules

### `src/lib/types.ts` — one extension

`Staff.partnerId?: PartnerId` is already there from P2. P3 just starts enforcing it.

**Add `partnerId: PartnerId` to `Schedule`** (required). P2 added the field to Customer and Transfer but not Schedule — closing that gap is part of P3 because the scoped store needs it to filter `listSchedules()` cleanly without per-row customer lookups.

- New schedules carry `partnerId` derived from the owning customer at create time (the bot tool that creates a schedule already has the senderPhone → can fetch the customer's partnerId).
- Old schedules get lazy-filled on read in `scheduleStore.getSchedule()` by looking up the customer via `senderPhone` (one extra read, only for legacy records; in-memory only — no persisting writes from read paths).
- New sentinel-guarded backfill `backfillSchedulesOnce` in `migration.ts` (fourth migration in the cron sweep) persists the lazy-filled value once after deploy.

### `src/lib/staff-scope.ts` — new file (~30 LOC)

Pure helpers, no Redis access. Trivially testable.

```ts
import type { PartnerId, Staff } from './types';

export type Scope =
  | { kind: 'platform' }
  | { kind: 'partner'; partnerId: PartnerId };

export function scopeOf(staff: Staff): Scope {
  return staff.partnerId
    ? { kind: 'partner', partnerId: staff.partnerId }
    : { kind: 'platform' };
}

export function canSee(scope: Scope, partnerId: PartnerId): boolean {
  return scope.kind === 'platform' || scope.partnerId === partnerId;
}
```

### `src/lib/scoped-store.ts` — new file (~80 LOC)

Thin facade over `Store` + `CustomerStore` + `PartnerStore` + `ScheduleStore`. Method signatures mirror the underlying stores so swapping is mechanical.

```ts
import type { Staff } from './types';
import { scopeOf, canSee } from './staff-scope';
import { getStore } from './store';
import { getCustomerStore } from './customer-store';
import { getPartnerStore } from './partner-store';
import { getScheduleStore } from './schedule-store';

export function createScopedStore(staff: Staff) {
  const scope = scopeOf(staff);
  const store = getStore();
  const customerStore = getCustomerStore(store);
  const partnerStore = getPartnerStore();
  const scheduleStore = getScheduleStore();

  return {
    scope,
    async listTransfers() {
      const all = await store.listTransfers();
      return scope.kind === 'platform'
        ? all
        : all.filter((t) => t.partnerId === scope.partnerId);
    },
    async listCustomers() {
      const all = await customerStore.listCustomers();
      return scope.kind === 'platform'
        ? all
        : all.filter((c) => c.partnerId === scope.partnerId);
    },
    async listSchedules() {
      const all = await scheduleStore.listSchedules();
      return scope.kind === 'platform'
        ? all
        : all.filter((s) => s.partnerId === scope.partnerId);
      // Note: Schedule.partnerId is added in this same P3 batch — see Section 2.
    },
    async listPartners() {
      const all = await partnerStore.listPartners();
      return scope.kind === 'platform'
        ? all
        : all.filter((p) => p.id === scope.partnerId);
    },
    async getTransfer(id: string) {
      const t = await store.getTransfer(id);
      if (!t || !canSee(scope, t.partnerId)) return null;
      return t;
    },
    async getCustomer(phone: string) {
      const c = await customerStore.getCustomer(phone);
      if (!c || !canSee(scope, c.partnerId)) return null;
      return c;
    },
    async getPartner(id: string) {
      const p = await partnerStore.getPartner(id);
      if (!p || !canSee(scope, p.id)) return null;
      return p;
    },
  };
}

export type ScopedStore = ReturnType<typeof createScopedStore>;
```

### `src/lib/auth.ts` — extend (existing file)

Add two helpers next to `requireStaff`/`requireAdmin`:

```ts
// Requires platform-level admin (partnerId undefined + role 'admin').
// Use for /dashboard/team and partner CRUD actions.
export async function requirePlatformAdmin(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role !== 'admin' || staff.partnerId !== undefined) {
    redirect('/dashboard');
  }
  return staff;
}

// Convenience for pages — returns both staff and scope in one call.
export async function requireScope(): Promise<{ staff: Staff; scope: Scope }> {
  const staff = await requireStaff();
  return { staff, scope: scopeOf(staff) };
}
```

Modify `getCurrentStaff()` to enforce partner-suspension mid-session (see Section 4).

---

## 3. Page-level changes

### Sidebar — `src/app/dashboard/sidebar.tsx`

Add a `visibleNavItems(staff)` helper. Hide platform-only items for partner-scoped staff; add a `My partner` link that routes directly to the staff's own partner detail page.

```ts
function visibleNavItems(staff: Staff): NavItem[] {
  const base: NavItem[] = ['overview', 'transactions', 'schedules',
                           'customers', 'compliance', 'analytics'];
  if (!staff.partnerId) {
    // Platform staff: full nav + Partners list + Team (admin only)
    return [...base, 'partners', ...(staff.role === 'admin' ? ['team'] : [])];
  }
  // Partner-scoped: base nav + self-link
  return [...base, 'my-partner'];
}
```

The render loop reads from this list. `my-partner` renders as `<Link href={'/dashboard/partners/' + staff.partnerId}>My partner</Link>`.

### Page handlers — mechanical swap

Every dashboard page changes one line: `getStore()` → `createScopedStore(staff)`. Pages touched:

- `src/app/dashboard/page.tsx` (Overview)
- `src/app/dashboard/transactions/page.tsx`
- `src/app/dashboard/customers/page.tsx`
- `src/app/dashboard/customers/[phone]/page.tsx`
- `src/app/dashboard/schedules/page.tsx`
- `src/app/dashboard/compliance/page.tsx`
- `src/app/dashboard/analytics/page.tsx`
- `src/app/dashboard/partners/page.tsx`
- `src/app/dashboard/partners/[id]/page.tsx`

Pattern:

```ts
// Before:
const store = getStore();
const transfers = await store.listTransfers();

// After:
const { staff, scope } = await requireScope();
const store = createScopedStore(staff);
const transfers = await store.listTransfers();  // already filtered
```

### Partner column / filter on transactions + customers

P2 added a `Partner` column and `?partner=<id>` filter to `/dashboard/transactions` and `/dashboard/customers`. For partner-scoped users:

- The Partner column is redundant (all rows are their partner) → **hide** the column when `scope.kind === 'partner'`.
- The partner filter dropdown is meaningless → **hide** the filter form when `scope.kind === 'partner'`.

Tests assert both behaviors.

### Direct-URL safety net

Two redirects in addition to scoped-store filtering:

- Partner-scoped user navigating to `/dashboard/partners` (list page) → `redirect('/dashboard/partners/' + staff.partnerId)`.
- Any user without platform admin role navigating to `/dashboard/team` → `redirect('/dashboard')` (already enforced by changing the gate to `requirePlatformAdmin()`).
- Partner-scoped user navigating to another partner's `/dashboard/partners/<other-id>` or `/dashboard/customers/<phone-not-mine>` → scoped `getPartner`/`getCustomer` returns null → existing `notFound()` call fires → 404.

### Staff CRUD on `/dashboard/partners/[id]`

Add a third panel to the partner detail page: **"Staff for this partner."**

- Lists all staff where `partnerId === <id>`.
- Columns: name, username, role, createdAt.
- `[+ Invite staff]` button (visible only to platform admins) opens a form.
- Form fields: username, name, password, role (`admin` | `agent`). Submit calls `createPartnerStaffAction`.
- `[Remove]` button next to each row calls `removeStaffAction`.

Server actions in `src/app/dashboard/partners/actions.ts`:

```ts
export async function createPartnerStaffAction(partnerId: PartnerId, formData: FormData) {
  await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '');
  const name = String(formData.get('name') ?? '');
  const password = String(formData.get('password') ?? '');
  const role = String(formData.get('role') ?? 'agent') as StaffRole;
  if (!['admin', 'agent'].includes(role)) throw new Error('Invalid role');
  if (!username || !name || !password) throw new Error('Missing fields');
  const passwordHash = await hashPassword(password);
  await getAuthStore().upsertStaff({
    username, name, role, passwordHash,
    partnerId,  // CANNOT be overridden by form — taken from URL param
    permissions: { canCancel: false, canResend: false, canAssign: false },
    createdAt: new Date().toISOString(),
  });
  revalidatePath('/dashboard/partners/' + partnerId);
}

export async function removeStaffAction(username: string) {
  await requirePlatformAdmin();
  await getAuthStore().deleteStaff(username);
  await getAuthStore().deleteAllSessionsFor(username);
  // partnerId for revalidation is looked up before delete
}
```

### `/dashboard/team` adjustment

Change the gate from `requireAdmin()` to `requirePlatformAdmin()`. Change the list source from "all staff" to "platform staff only" (`staff.filter(s => !s.partnerId)`). Partner staff now live on their partner's detail page.

---

## 4. Auth flow + suspended partner behavior

### Login action — `src/app/login/actions.ts`

Add a single check after credential verification. Same login form, same UX — the gate is invisible until it triggers, and the error message is generic so credential validity isn't leaked.

```ts
export async function loginAction(formData: FormData) {
  // ... existing credential check ...
  const staff = await authStore.getStaff(username);
  if (!staff || !(await verifyPassword(password, staff.passwordHash))) {
    return { error: 'Invalid credentials' };
  }

  // NEW (P3): block login for partner-scoped staff whose partner is suspended.
  if (staff.partnerId) {
    const partner = await getPartnerStore().getPartner(staff.partnerId);
    if (!partner || partner.status !== 'active') {
      return { error: 'Account unavailable. Contact SendHome support.' };
    }
  }

  // ... existing session-cookie creation ...
}
```

### Session revalidation — `src/lib/auth.ts`

`getCurrentStaff()` also re-checks partner status on every dashboard request so a platform admin who suspends a partner mid-session bounces that partner's staff on the next page load.

```ts
export async function getCurrentStaff(): Promise<Staff | null> {
  // ... existing cookie + session lookup ...
  const staff = await getAuthStore().getStaff(username);
  if (!staff) return null;

  // NEW (P3): mid-session partner-suspension enforcement.
  if (staff.partnerId) {
    const partner = await getPartnerStore().getPartner(staff.partnerId);
    if (!partner || partner.status !== 'active') return null;  // forces /login redirect
  }

  return staff;
}
```

### Proactive session revocation — `src/app/dashboard/partners/actions.ts`

When `setPartnerStatusAction` flips a partner to `suspended`, walk that partner's staff and delete their sessions immediately. Without this the bounce would still happen, but it would take until the staff's next page request — proactive deletion makes the eviction instant.

```ts
// In setPartnerStatusAction, after partnerStore.savePartner(updated):
if (updated.status === 'suspended') {
  const allStaff = await authStore.listStaff();
  const affected = allStaff.filter((s) => s.partnerId === partnerId);
  for (const s of affected) {
    await authStore.deleteAllSessionsFor(s.username);
  }
}
```

Reactivation does not auto-restore sessions (they were deleted). Affected staff just log in again. No code needed.

### `auth-store` changes

`deleteStaff(username)` already exists (it removes the staff record and the index entry). One new method is needed:

```ts
// Removes every active session for this username. Idempotent.
deleteAllSessionsFor(username: string): Promise<void>;
```

Upstash doesn't expose `SCAN` cleanly, so we maintain a reverse index. Update the existing `createSession` to also `sadd('staff_sessions:' + username, token)`, and `deleteSession` to `srem` the same set. `deleteAllSessionsFor` then reads the set, deletes each `session:<token>` key, and deletes the set itself.

```ts
async createSession(username: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await redis.set('session:' + token, username, { ex: SESSION_TTL_SECONDS });
  await redis.sadd('staff_sessions:' + username, token);  // NEW
  return token;
}
async deleteSession(token: string): Promise<void> {
  const username = await redis.get('session:' + token);
  await redis.del('session:' + token);
  if (username) await redis.srem('staff_sessions:' + username, token);  // NEW
}
async deleteAllSessionsFor(username: string): Promise<void> {
  const tokens = await redis.smembers('staff_sessions:' + username);
  for (const t of tokens) await redis.del('session:' + t);
  await redis.del('staff_sessions:' + username);
}
```

Backward compatibility: existing sessions (created pre-P3) won't be in any reverse-index set, so they can't be force-deleted via this path. They expire naturally on `SESSION_TTL_SECONDS`. Once a staff member next logs in, all subsequent sessions are revocable. Acceptable since the only revocation trigger is partner-suspension, and partners can also be re-activated before any sessions become stuck.

### Tradeoff acknowledged

The mid-session check adds one Redis read per page load for partner-scoped staff (a `partner:<id>` get). Platform admin path is unchanged. Negligible cost given Upstash latency (~5ms) and the fact that dashboard pages already make 5+ Redis calls.

---

## 5. Testing strategy

### Unit tests (vitest)

| File | What it locks in |
|---|---|
| `tests/staff-scope.test.ts` (NEW) | `scopeOf()` returns `platform` for partnerId-less staff, `partner` for scoped. `canSee()` table: platform sees any partnerId; partner sees only own; partner does not see other. |
| `tests/scoped-store.test.ts` (NEW) | Core contract. Seed two partners + 4 transfers (2 each) + 4 customers (2 each). Assert: platform staff sees all 4 of each; partner-A staff sees only A's 2; partner-B sees only B's 2. Single-record reads: `getTransfer(B's id)` returns null for partner-A. Same for `getCustomer`, `getPartner`. |
| `tests/auth-suspended-partner.test.ts` (NEW) | `getCurrentStaff()` returns null when staff's partner is suspended. Login action rejects with generic error message. Platform staff are unaffected by any partner's status. |
| `tests/auth-store-sessions.test.ts` (NEW) | `deleteAllSessionsFor(username)` removes only that user's sessions, leaves others. Idempotent on missing username. |
| `tests/partners-actions.test.ts` (extend) | Existing P2 tests + new: `setPartnerStatusAction('suspended')` deletes affected staff sessions; `createPartnerStaffAction` forces `partnerId` to the URL param (cannot be overridden via form); `removeStaffAction` deletes both staff record and sessions. |
| `tests/sidebar.test.ts` (NEW) | `visibleNavItems(staff)` table: platform admin → 8 items including `partners` and `team`; platform agent → 7 (no team); partner admin → 7 (base + my-partner); partner agent → same 7. |
| `tests/schedule-store-partnerId.test.ts` (NEW) | `getSchedule()` lazy-fills `partnerId` from the customer for legacy records (in-memory only). New schedules write with `partnerId` populated. `listSchedules` returns all with `partnerId` after lazy fill. |
| `tests/migration.test.ts` (extend) | `backfillSchedulesOnce` is sentinel-gated, idempotent, and persists `partnerId` on all existing schedules. Walks customers to resolve unknown senderPhone → defaults to `'default'` if customer missing (defensive). |

### Integration / page tests

None beyond the existing E2E smoke. Pages are mechanical swaps of `getStore()` → `createScopedStore(staff)`; the scoped-store unit tests prove the filtering.

### E2E smoke — extend `tests/e2e/dashboard-smoke.spec.ts`

Add a second test case that logs in as a partner-scoped staff fixture and asserts:

- Sidebar does NOT contain `Partners` (list) link or `Team` link.
- Sidebar DOES contain `My partner` link.
- Navigating to `/dashboard/partners` redirects to `/dashboard/partners/<id>`.
- Navigating to `/dashboard/team` redirects to `/dashboard`.
- Customers table only shows their partner's rows (assertable once seed data is in place).

Requires a seeded partner staff in prod. Extend `src/lib/seed.ts`:

```ts
// After the platform admin seed, also seed a partner staff if configured.
if (env.seedPartnerUsername && env.seedPartnerPassword && env.seedPartnerId) {
  await authStore.upsertStaff({
    username: env.seedPartnerUsername,
    name: 'Partner Staff (seed)',
    role: 'admin',
    partnerId: env.seedPartnerId,
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: await hashPassword(env.seedPartnerPassword),
    createdAt: new Date().toISOString(),
  });
}
```

Idempotent: `upsertStaff` is a noop if the user already exists. Env vars added to `.env.example` and to Vercel project settings. The smoke workflow passes `E2E_PARTNER_USERNAME` / `E2E_PARTNER_PASSWORD` to Playwright.

### Manual eyeball after deploy

- Platform admin: everything unchanged from P2; should see no behavior difference.
- Partner admin (using seeded account): log in, see only their data on every page, cannot reach `/dashboard/team` or any other partner's pages by URL guessing.
- Suspend a partner via the dashboard; that partner's staff bounces to login on next click.

### Test count delta

~30 new tests (25 for auth/scoping/sidebar + ~5 for Schedule.partnerId and the new migration). Suite goes from 354 (post-hotfix-PR-9) → ~384.

---

## 6. CI/CD ship pipeline

Same as PRs #5–#9:

1. Branch `feat/p3-partner-sub-admin-auth` off `main`.
2. Subagent-driven implementation, task-by-task, with two-stage review per task.
3. Push branch → open PR → CI green (typecheck + lint + tests + build).
4. Merge through branch protection (required check: `ci`) → Vercel auto-deploys → post-deploy `Smoke` workflow on `deployment_status: success`.
5. Verify the partner-scoped smoke case passes against prod.

After merge: hit `/api/cron?secret=<CRON_SECRET>` once to run `backfillSchedulesOnce` (idempotent; gated by sentinel). All prior migrations stay no-op on second run because their sentinels are already claimed.

---

## 7. Open questions / explicit deferrals

- **Audit log of who-acted-on-what.** Not in P3. May land in P5 (per-corridor compliance brings audit needs to the front).
- **Password reset / invite emails.** Not in P3. Platform admin sets password manually via the create form (same as today for platform staff). Email-based invite flow can land later.
- **Partner-admin self-service for inviting their own people.** Deferred (Q3 answered above).
- **Per-partner branding / whitelabel on login screen.** Deferred — P2's `Partner.whitelabel` placeholder is unused by P3.
- **Rate-limiting or audit of failed login attempts for partner staff.** Inherits whatever the existing login flow has (today: nothing special).
