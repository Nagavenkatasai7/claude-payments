# Multi-User: Concurrency Hardening + Staff Auth & Permissions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SendHome safely multi-user — atomic data writes for many concurrent customers, plus a login system with a main admin who manages team agents and their permissions.

**Architecture:** Part A swaps non-atomic read-modify-write Redis patterns for atomic operations (`sadd`/`incr`). Part B adds staff accounts (scrypt-hashed passwords in Redis), Redis-backed sessions via an httpOnly cookie, `middleware.ts` gating `/dashboard`, and an admin-only Team page that grants per-agent permissions enforced in both the UI and server actions.

**Tech Stack:** Next.js 16, TypeScript, Vitest, `@upstash/redis`, Node `crypto` (scrypt).

Reference: the design agreed in conversation on 2026-05-21 (multi-user; roles admin/agent; per-agent permissions canCancel/canResend/canAssign).

---

## File Structure

```
NEW  src/lib/permissions.ts        - pure hasPermission()
NEW  src/lib/password.ts           - scrypt hash/verify
NEW  src/lib/session-cookie.ts     - SESSION_COOKIE constant (no heavy imports)
NEW  src/lib/auth-store.ts         - staff CRUD + sessions in Redis
NEW  src/lib/seed.ts               - ensureSeedAdmin()
NEW  src/lib/auth.ts               - getCurrentStaff/requireStaff/requireAdmin (Next request context)
NEW  src/middleware.ts             - gate /dashboard
NEW  src/app/login/page.tsx        - login page
NEW  src/app/login/login-form.tsx  - client login form
NEW  src/app/login/actions.ts      - login / logout server actions
NEW  src/app/dashboard/team/page.tsx     - admin-only Team & Permissions page
NEW  src/app/dashboard/team/actions.ts   - addStaff / updatePermissions / removeStaff
MOD  src/lib/types.ts              - Staff, StaffRole, StaffPermissions
MOD  src/lib/store.ts              - RedisLike +incr/sadd/srem/smembers/del; atomic index + count
MOD  src/lib/tools.ts              - use getTransferCount
MOD  src/lib/env.ts                - SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD
MOD  src/app/dashboard/page.tsx    - auth gate, header, permission-gated actions, staff dropdown
MOD  src/app/dashboard/actions.ts  - server-side permission enforcement
MOD  src/app/globals.css           - login + team + header styles
MOD  tests/helpers.ts              - fakeRedis: incr/sadd/srem/smembers/del
```

---

## Task 1: Extend RedisLike + fakeRedis with atomic operations

**Files:**
- Modify: `src/lib/store.ts` (the `RedisLike` interface only)
- Modify: `tests/helpers.ts`
- Test: `tests/helpers-redis.test.ts` (new)

- [ ] **Step 1: Write the failing test `tests/helpers-redis.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { fakeRedis } from './helpers';

describe('fakeRedis atomic operations', () => {
  it('incr starts at 1 and increments', async () => {
    const r = fakeRedis();
    expect(await r.incr('c')).toBe(1);
    expect(await r.incr('c')).toBe(2);
  });

  it('sadd is idempotent and smembers lists members', async () => {
    const r = fakeRedis();
    await r.sadd('s', 'a');
    await r.sadd('s', 'b');
    await r.sadd('s', 'a');
    expect((await r.smembers('s')).sort()).toEqual(['a', 'b']);
  });

  it('srem removes a member', async () => {
    const r = fakeRedis();
    await r.sadd('s', 'a');
    await r.sadd('s', 'b');
    await r.srem('s', 'a');
    expect(await r.smembers('s')).toEqual(['b']);
  });

  it('del removes a key and a set', async () => {
    const r = fakeRedis();
    await r.set('k', 'v');
    await r.sadd('s', 'a');
    await r.del('k');
    await r.del('s');
    expect(await r.get('k')).toBeNull();
    expect(await r.smembers('s')).toEqual([]);
  });

  it('smembers returns empty array for an unknown set', async () => {
    expect(await fakeRedis().smembers('nope')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- helpers-redis`
Expected: FAIL — `r.incr is not a function`.

- [ ] **Step 3: Extend the `RedisLike` interface in `src/lib/store.ts`**

Replace the existing `RedisLike` interface with:

```ts
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    opts?: { ex?: number; nx?: boolean },
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}
```

- [ ] **Step 4: Extend `fakeRedis` in `tests/helpers.ts`**

Replace the body of `fakeRedis` so it returns an object backing string keys with one `Map` and sets with another:

```ts
import type { RedisLike } from '@/lib/store';

export interface FakeRedis extends RedisLike {
  dump: Map<string, string>;
}

export function fakeRedis(): FakeRedis {
  const map = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    dump: map,
    async get(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    async set(
      key: string,
      value: string,
      opts?: { ex?: number; nx?: boolean },
    ) {
      if (opts?.nx && map.has(key)) return null;
      map.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      map.delete(key);
      sets.delete(key);
      return 1;
    },
    async incr(key: string) {
      const next = (map.has(key) ? parseInt(map.get(key)!, 10) : 0) + 1;
      map.set(key, String(next));
      return next;
    },
    async sadd(key: string, member: string) {
      let s = sets.get(key);
      if (!s) {
        s = new Set();
        sets.set(key, s);
      }
      s.add(member);
      return 1;
    },
    async srem(key: string, member: string) {
      sets.get(key)?.delete(member);
      return 1;
    },
    async smembers(key: string) {
      return [...(sets.get(key) ?? [])];
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- helpers-redis`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/store.ts tests/helpers.ts tests/helpers-redis.test.ts
git commit -m "feat: extend RedisLike + fakeRedis with atomic operations"
```

---

## Task 2: Atomic transfers index + transfer count (concurrency hardening)

**Files:**
- Modify: `src/lib/store.ts`
- Modify: `src/lib/tools.ts`
- Modify: `tests/store.test.ts`
- Test: `tests/store.test.ts`

The current `saveTransfer` maintains `transfers:index` as a JSON array (read-modify-write), and transfer counts live in a `user:{phone}` JSON record. Both race under concurrent use. Switch to a Redis set and `incr`.

- [ ] **Step 1: Update `tests/store.test.ts`**

Replace any test referencing `getUser` / `incrementTransferCount` returning a record, and the `transfers:index` array, with these (keep the existing transfer round-trip / conversation / dedupe tests):

```ts
import { describe, it, expect } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import type { Transfer } from '@/lib/types';

function sampleTransfer(id: string, createdAt: string): Transfer {
  return {
    id,
    phone: '15551234567',
    amountUsd: 500,
    feeUsd: 0,
    totalChargeUsd: 500,
    fxRate: 85,
    amountInr: 42500,
    recipientName: 'Mom',
    recipientPhone: '919133001840',
    payoutMethod: 'upi',
    payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer',
    status: 'awaiting_payment',
    createdAt,
  };
}

describe('store transfers index', () => {
  it('listTransfers returns saved transfers newest-first', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(sampleTransfer('a', '2026-05-21T01:00:00.000Z'));
    await store.saveTransfer(sampleTransfer('b', '2026-05-21T03:00:00.000Z'));
    await store.saveTransfer(sampleTransfer('c', '2026-05-21T02:00:00.000Z'));
    const ids = (await store.listTransfers()).map((t) => t.id);
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('re-saving a transfer does not duplicate it in the index', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(sampleTransfer('a', '2026-05-21T01:00:00.000Z'));
    await store.saveTransfer(sampleTransfer('a', '2026-05-21T01:00:00.000Z'));
    expect(await store.listTransfers()).toHaveLength(1);
  });
});

describe('store transfer count', () => {
  it('defaults to 0 and increments atomically', async () => {
    const store = createStore(fakeRedis());
    expect(await store.getTransferCount('p')).toBe(0);
    await store.incrementTransferCount('p');
    await store.incrementTransferCount('p');
    expect(await store.getTransferCount('p')).toBe(2);
  });

  it('counts are isolated per phone', async () => {
    const store = createStore(fakeRedis());
    await store.incrementTransferCount('p1');
    expect(await store.getTransferCount('p1')).toBe(1);
    expect(await store.getTransferCount('p2')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- store.test`
Expected: FAIL — `store.getTransferCount is not a function`.

- [ ] **Step 3: Update `src/lib/store.ts`**

In `createStore`, replace the `saveTransfer` index logic, the `listTransfers` reader, and the `getUser`/`incrementTransferCount` methods:

```ts
    async saveTransfer(transfer: Transfer): Promise<void> {
      await redis.set(`transfer:${transfer.id}`, JSON.stringify(transfer));
      await redis.sadd('transfers:index', transfer.id);
    },
    async listTransfers(): Promise<Transfer[]> {
      const ids = await redis.smembers('transfers:index');
      const all = await Promise.all(ids.map((id) => this.getTransfer(id)));
      return all
        .filter((t): t is Transfer => t !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getTransferCount(phone: string): Promise<number> {
      const raw = await redis.get(`count:${phone}`);
      return raw ? Number(raw) : 0;
    },
    async incrementTransferCount(phone: string): Promise<void> {
      await redis.incr(`count:${phone}`);
    },
```

Remove the old `getUser` method and any `UserRecord` import in `store.ts`. (Leave `getConversation`, `saveConversation`, `getTransfer`, `markMessageSeen` unchanged.)

- [ ] **Step 4: Update `src/lib/tools.ts`**

In the `get_quote` and `create_transfer` executors, replace `const user = await ctx.store.getUser(ctx.phone);` + `user.transferCount` with:

```ts
    const transferCount = await ctx.store.getTransferCount(ctx.phone);
```

and pass `transferCount` where `user.transferCount` was used.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all files green (store + tools).

- [ ] **Step 6: Commit**

```bash
git add src/lib/store.ts src/lib/tools.ts tests/store.test.ts
git commit -m "feat: atomic transfers index and transfer count for concurrent customers"
```

---

## Task 3: Password hashing

**Files:**
- Create: `src/lib/password.ts`
- Test: `tests/password.test.ts`

- [ ] **Step 1: Write the failing test `tests/password.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/password';

describe('password', () => {
  it('verifies a correct password', () => {
    const stored = hashPassword('s3cret!');
    expect(verifyPassword('s3cret!', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('s3cret!');
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('produces a different hash each time (random salt)', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('rejects a malformed stored value', () => {
    expect(verifyPassword('x', 'not-a-valid-hash')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- password`
Expected: FAIL — cannot resolve `@/lib/password`.

- [ ] **Step 3: Create `src/lib/password.ts`**

```ts
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(plain, salt, 64);
  return (
    expected.length === actual.length && timingSafeEqual(expected, actual)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- password`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/password.ts tests/password.test.ts
git commit -m "feat: add scrypt password hashing"
```

---

## Task 4: Staff types, session-cookie constant, env vars

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/lib/session-cookie.ts`
- Modify: `src/lib/env.ts`

Types and constants only — no test (verified by `tsc` in later tasks).

- [ ] **Step 1: Append to `src/lib/types.ts`**

```ts
export type StaffRole = 'admin' | 'agent';

export interface StaffPermissions {
  canCancel: boolean;
  canResend: boolean;
  canAssign: boolean;
}

export interface Staff {
  username: string;
  name: string;
  role: StaffRole;
  permissions: StaffPermissions;
  passwordHash: string;
  createdAt: string;
}
```

- [ ] **Step 2: Create `src/lib/session-cookie.ts`**

```ts
// Isolated so middleware can import the cookie name without pulling in
// next/headers or the Redis client.
export const SESSION_COOKIE = 'sendhome_session';
```

- [ ] **Step 3: Add to the `env` object in `src/lib/env.ts`**

Add these two getters alongside the existing ones:

```ts
  get seedAdminUsername() {
    return required('SEED_ADMIN_USERNAME');
  },
  get seedAdminPassword() {
    return required('SEED_ADMIN_PASSWORD');
  },
```

- [ ] **Step 4: Add seed vars to `tests/setup.ts`**

Append:

```ts
process.env.SEED_ADMIN_USERNAME ||= 'admin';
process.env.SEED_ADMIN_PASSWORD ||= 'admin-test-pw';
```

- [ ] **Step 5: Verify the build still type-checks**

Run: `npm run build`
Expected: PASS — compiles with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/session-cookie.ts src/lib/env.ts tests/setup.ts
git commit -m "feat: add Staff types, session cookie constant, seed-admin env vars"
```

---

## Task 5: Auth store — staff CRUD + sessions

**Files:**
- Create: `src/lib/auth-store.ts`
- Test: `tests/auth-store.test.ts`

- [ ] **Step 1: Write the failing test `tests/auth-store.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createAuthStore } from '@/lib/auth-store';
import { fakeRedis } from './helpers';
import type { Staff } from '@/lib/types';

function staff(username: string, createdAt: string): Staff {
  return {
    username,
    name: username.toUpperCase(),
    role: 'agent',
    permissions: { canCancel: false, canResend: true, canAssign: false },
    passwordHash: 'salt:hash',
    createdAt,
  };
}

describe('auth-store staff', () => {
  it('round-trips a staff member', async () => {
    const s = createAuthStore(fakeRedis());
    await s.saveStaff(staff('priya', '2026-05-21T01:00:00.000Z'));
    const loaded = await s.getStaff('priya');
    expect(loaded?.name).toBe('PRIYA');
  });

  it('returns null for an unknown staff member', async () => {
    expect(await createAuthStore(fakeRedis()).getStaff('nobody')).toBeNull();
  });

  it('lists staff sorted by createdAt', async () => {
    const s = createAuthStore(fakeRedis());
    await s.saveStaff(staff('b', '2026-05-21T03:00:00.000Z'));
    await s.saveStaff(staff('a', '2026-05-21T01:00:00.000Z'));
    expect((await s.listStaff()).map((x) => x.username)).toEqual(['a', 'b']);
  });

  it('deletes a staff member', async () => {
    const s = createAuthStore(fakeRedis());
    await s.saveStaff(staff('a', '2026-05-21T01:00:00.000Z'));
    await s.deleteStaff('a');
    expect(await s.getStaff('a')).toBeNull();
    expect(await s.listStaff()).toHaveLength(0);
  });
});

describe('auth-store sessions', () => {
  it('creates a session and resolves it back to the username', async () => {
    const s = createAuthStore(fakeRedis());
    const token = await s.createSession('priya');
    expect(typeof token).toBe('string');
    expect(await s.getSessionUser(token)).toBe('priya');
  });

  it('returns null for an unknown session token', async () => {
    expect(await createAuthStore(fakeRedis()).getSessionUser('x')).toBeNull();
  });

  it('deletes a session', async () => {
    const s = createAuthStore(fakeRedis());
    const token = await s.createSession('priya');
    await s.deleteSession(token);
    expect(await s.getSessionUser(token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- auth-store`
Expected: FAIL — cannot resolve `@/lib/auth-store`.

- [ ] **Step 3: Create `src/lib/auth-store.ts`**

```ts
import { Redis } from '@upstash/redis';
import { randomBytes } from 'node:crypto';
import { env } from './env';
import type { RedisLike } from './store';
import type { Staff } from './types';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createAuthStore(redis: RedisLike) {
  return {
    async getStaff(username: string): Promise<Staff | null> {
      const raw = await redis.get(`staff:${username}`);
      return raw ? (JSON.parse(raw) as Staff) : null;
    },
    async saveStaff(staff: Staff): Promise<void> {
      await redis.set(`staff:${staff.username}`, JSON.stringify(staff));
      await redis.sadd('staff:index', staff.username);
    },
    async listStaff(): Promise<Staff[]> {
      const usernames = await redis.smembers('staff:index');
      const all = await Promise.all(
        usernames.map((u) => this.getStaff(u)),
      );
      return all
        .filter((s): s is Staff => s !== null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async deleteStaff(username: string): Promise<void> {
      await redis.del(`staff:${username}`);
      await redis.srem('staff:index', username);
    },
    async createSession(username: string): Promise<string> {
      const token = randomBytes(32).toString('hex');
      await redis.set(`session:${token}`, username, {
        ex: SESSION_TTL_SECONDS,
      });
      return token;
    },
    async getSessionUser(token: string): Promise<string | null> {
      return redis.get(`session:${token}`);
    },
    async deleteSession(token: string): Promise<void> {
      await redis.del(`session:${token}`);
    },
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;

let cached: AuthStore | null = null;

export function getAuthStore(): AuthStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createAuthStore(redis as unknown as RedisLike);
  }
  return cached;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- auth-store`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth-store.ts tests/auth-store.test.ts
git commit -m "feat: add auth store for staff and sessions"
```

---

## Task 6: Permissions helper + seed admin

**Files:**
- Create: `src/lib/permissions.ts`
- Create: `src/lib/seed.ts`
- Test: `tests/permissions.test.ts`, `tests/seed.test.ts`

- [ ] **Step 1: Write the failing test `tests/permissions.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { hasPermission } from '@/lib/permissions';
import type { Staff } from '@/lib/types';

function make(role: 'admin' | 'agent', perms: Partial<Staff['permissions']>): Staff {
  return {
    username: 'u',
    name: 'U',
    role,
    permissions: {
      canCancel: false,
      canResend: false,
      canAssign: false,
      ...perms,
    },
    passwordHash: 'x',
    createdAt: '2026-05-21T00:00:00.000Z',
  };
}

describe('hasPermission', () => {
  it('admin has every permission', () => {
    const admin = make('admin', {});
    expect(hasPermission(admin, 'canCancel')).toBe(true);
    expect(hasPermission(admin, 'canResend')).toBe(true);
    expect(hasPermission(admin, 'canAssign')).toBe(true);
  });

  it('agent has only the permissions granted', () => {
    const agent = make('agent', { canResend: true });
    expect(hasPermission(agent, 'canResend')).toBe(true);
    expect(hasPermission(agent, 'canCancel')).toBe(false);
    expect(hasPermission(agent, 'canAssign')).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing test `tests/seed.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { ensureSeedAdmin } from '@/lib/seed';
import { createAuthStore } from '@/lib/auth-store';
import { verifyPassword } from '@/lib/password';
import { fakeRedis } from './helpers';

describe('ensureSeedAdmin', () => {
  it('creates an admin from env when no staff exist', async () => {
    const store = createAuthStore(fakeRedis());
    await ensureSeedAdmin(store);
    const admin = await store.getStaff('admin'); // SEED_ADMIN_USERNAME in tests/setup.ts
    expect(admin?.role).toBe('admin');
    expect(verifyPassword('admin-test-pw', admin!.passwordHash)).toBe(true);
  });

  it('does nothing when staff already exist', async () => {
    const store = createAuthStore(fakeRedis());
    await ensureSeedAdmin(store);
    await ensureSeedAdmin(store);
    expect(await store.listStaff()).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- permissions seed`
Expected: FAIL — cannot resolve `@/lib/permissions` / `@/lib/seed`.

- [ ] **Step 4: Create `src/lib/permissions.ts`**

```ts
import type { Staff, StaffPermissions } from './types';

export function hasPermission(
  staff: Staff,
  permission: keyof StaffPermissions,
): boolean {
  if (staff.role === 'admin') return true;
  return staff.permissions[permission] === true;
}
```

- [ ] **Step 5: Create `src/lib/seed.ts`**

```ts
import { env } from './env';
import { hashPassword } from './password';
import { getAuthStore, type AuthStore } from './auth-store';
import type { Staff } from './types';

export async function ensureSeedAdmin(
  store: AuthStore = getAuthStore(),
): Promise<void> {
  const existing = await store.listStaff();
  if (existing.length > 0) return;
  const admin: Staff = {
    username: env.seedAdminUsername,
    name: 'Main Admin',
    role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: hashPassword(env.seedAdminPassword),
    createdAt: new Date().toISOString(),
  };
  await store.saveStaff(admin);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- permissions seed`
Expected: PASS — 4 tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/permissions.ts src/lib/seed.ts tests/permissions.test.ts tests/seed.test.ts
git commit -m "feat: add permissions helper and seed-admin bootstrap"
```

---

## Task 7: Auth helpers (request-context)

**Files:**
- Create: `src/lib/auth.ts`

No unit test — these functions need a Next.js request context. They are exercised by the dashboard/login tasks and manual verification. Keep the file tiny so it is obviously correct.

- [ ] **Step 1: Create `src/lib/auth.ts`**

```ts
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthStore } from './auth-store';
import { SESSION_COOKIE } from './session-cookie';
import type { Staff } from './types';

export async function getCurrentStaff(): Promise<Staff | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const username = await getAuthStore().getSessionUser(token);
  if (!username) return null;
  return getAuthStore().getStaff(username);
}

export async function requireStaff(): Promise<Staff> {
  const staff = await getCurrentStaff();
  if (!staff) redirect('/login');
  return staff;
}

export async function requireAdmin(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role !== 'admin') redirect('/dashboard');
  return staff;
}
```

- [ ] **Step 2: Verify the build type-checks**

Run: `npm run build`
Expected: PASS — compiles with no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/auth.ts
git commit -m "feat: add request-context auth helpers"
```

---

## Task 8: Middleware + login page + login/logout actions

**Files:**
- Create: `src/middleware.ts`
- Create: `src/app/login/actions.ts`
- Create: `src/app/login/login-form.tsx`
- Create: `src/app/login/page.tsx`
- Test: `tests/middleware.test.ts`

- [ ] **Step 1: Write the failing test `tests/middleware.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { SESSION_COOKIE } from '@/lib/session-cookie';

describe('middleware', () => {
  it('redirects to /login when no session cookie is present', () => {
    const req = new NextRequest('https://app.test/dashboard');
    const res = middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('allows the request through when a session cookie exists', () => {
    const req = new NextRequest('https://app.test/dashboard');
    req.cookies.set(SESSION_COOKIE, 'some-token');
    const res = middleware(req);
    // NextResponse.next() has no redirect location
    expect(res.headers.get('location')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- middleware`
Expected: FAIL — cannot resolve `@/middleware`.

- [ ] **Step 3: Create `src/middleware.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session-cookie';

export function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard', '/dashboard/:path*'],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- middleware`
Expected: PASS — 2 tests.

- [ ] **Step 5: Create `src/app/login/actions.ts`**

```ts
'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthStore } from '@/lib/auth-store';
import { ensureSeedAdmin } from '@/lib/seed';
import { verifyPassword } from '@/lib/password';
import { SESSION_COOKIE } from '@/lib/session-cookie';

export async function login(
  _prev: string | null,
  formData: FormData,
): Promise<string | null> {
  await ensureSeedAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const staff = await getAuthStore().getStaff(username);
  if (!staff || !verifyPassword(password, staff.passwordHash)) {
    return 'Invalid username or password.';
  }
  const token = await getAuthStore().createSession(username);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
  redirect('/dashboard');
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await getAuthStore().deleteSession(token);
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}
```

- [ ] **Step 6: Create `src/app/login/login-form.tsx`**

```tsx
'use client';

import { useActionState } from 'react';
import { login } from './actions';

export function LoginForm() {
  const [error, formAction, pending] = useActionState(login, null);
  return (
    <form action={formAction} className="login-form">
      <label>
        Username
        <input name="username" required autoComplete="username" />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
      {error && <p className="err">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 7: Create `src/app/login/page.tsx`**

```tsx
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main className="card">
      <div className="brand">SendHome</div>
      <h1>Staff sign in</h1>
      <LoginForm />
    </main>
  );
}
```

- [ ] **Step 8: Run the suite and build**

Run: `npm test`
Expected: PASS — all green.
Run: `npm run build`
Expected: PASS — `/login` route compiled, `middleware` reported.

- [ ] **Step 9: Commit**

```bash
git add src/middleware.ts "src/app/login" tests/middleware.test.ts
git commit -m "feat: add middleware gate and staff login/logout"
```

---

## Task 9: Dashboard — auth gate, header, permission-gated actions

**Files:**
- Modify: `src/app/dashboard/page.tsx`
- Modify: `src/app/dashboard/actions.ts`

- [ ] **Step 1: Update `src/app/dashboard/actions.ts` — enforce permissions server-side**

Replace the file with:

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { getStore } from '@/lib/store';
import { sendText } from '@/lib/whatsapp';
import {
  cancelTransfer,
  assignTransfer,
  resendPaymentLink,
} from '@/lib/dashboard-ops';
import { requireStaff } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import type { StaffPermissions } from '@/lib/types';

async function requirePermission(
  permission: keyof StaffPermissions,
): Promise<void> {
  const staff = await requireStaff();
  if (!hasPermission(staff, permission)) {
    throw new Error('You do not have permission to perform this action.');
  }
}

export async function cancelTransferAction(formData: FormData): Promise<void> {
  await requirePermission('canCancel');
  const id = formData.get('id') as string;
  await cancelTransfer(getStore(), id);
  revalidatePath('/dashboard');
}

export async function assignTransferAction(formData: FormData): Promise<void> {
  await requirePermission('canAssign');
  const id = formData.get('id') as string;
  const assignee = (formData.get('assignee') as string) ?? '';
  const note = (formData.get('note') as string) ?? '';
  await assignTransfer(getStore(), id, assignee, note);
  revalidatePath('/dashboard');
}

export async function resendPaymentLinkAction(
  formData: FormData,
): Promise<void> {
  await requirePermission('canResend');
  const id = formData.get('id') as string;
  await resendPaymentLink(getStore(), sendText, id);
  revalidatePath('/dashboard');
}
```

- [ ] **Step 2: Update `src/app/dashboard/page.tsx`**

Replace the file with:

```tsx
export const dynamic = 'force-dynamic';

import { getStore } from '@/lib/store';
import { getAuthStore } from '@/lib/auth-store';
import { requireStaff } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { summarize, isAbandoned } from '@/lib/dashboard';
import { logout } from '../login/actions';
import { LiveRefresh } from './live-refresh';
import type { Staff, Transfer } from '@/lib/types';

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
function inr(amount: number): string {
  return `₹${amount.toLocaleString('en-IN')}`;
}
function humanizeFunding(method: Transfer['fundingMethod']): string {
  if (method === 'credit_card') return 'Credit card';
  if (method === 'debit_card') return 'Debit card';
  return 'Bank transfer';
}

function StatusBadge({ status }: { status: Transfer['status'] }) {
  return (
    <span className={`status-badge status-${status}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function Stage({ at, fallback }: { at?: string; fallback: string }) {
  if (at) {
    return (
      <span className="stage-done">✓ {new Date(at).toLocaleString()}</span>
    );
  }
  return <span className="stage-pending">{fallback}</span>;
}

function AssignForm({ id, staff }: { id: string; staff: Staff[] }) {
  return (
    <form action={assignTransferAction} className="assign-form">
      <input type="hidden" name="id" value={id} />
      <select name="assignee" className="small-input" required>
        <option value="">Assign to…</option>
        {staff.map((s) => (
          <option key={s.username} value={s.username}>
            {s.name}
          </option>
        ))}
      </select>
      <input type="text" name="note" placeholder="Note" className="small-input" />
      <button type="submit" className="action-btn assign-btn">
        Assign
      </button>
    </form>
  );
}

import {
  cancelTransferAction,
  assignTransferAction,
  resendPaymentLinkAction,
} from './actions';

function TransferActions({
  transfer,
  viewer,
  staff,
}: {
  transfer: Transfer;
  viewer: Staff;
  staff: Staff[];
}) {
  const { status, id } = transfer;
  const canCancel = hasPermission(viewer, 'canCancel');
  const canResend = hasPermission(viewer, 'canResend');
  const canAssign = hasPermission(viewer, 'canAssign');

  return (
    <div className="action-group">
      {status === 'awaiting_payment' && canResend && (
        <form action={resendPaymentLinkAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="action-btn resend-btn">
            Resend link
          </button>
        </form>
      )}
      {(status === 'awaiting_payment' || status === 'paid') && canCancel && (
        <form action={cancelTransferAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="action-btn cancel-btn">
            Cancel/refund
          </button>
        </form>
      )}
      {canAssign && <AssignForm id={id} staff={staff} />}
    </div>
  );
}

export default async function DashboardPage() {
  const viewer = await requireStaff();
  const transfers = await getStore().listTransfers();
  const staff = await getAuthStore().listStaff();
  const now = Date.now();
  const summary = summarize(transfers, now);
  const abandoned = transfers.filter((t) => isAbandoned(t, now));
  const staffByUsername = new Map(staff.map((s) => [s.username, s.name]));

  return (
    <main className="dashboard">
      <header className="dash-header">
        <h1 className="dashboard-title">SendHome Admin</h1>
        <div className="dash-header-right">
          <LiveRefresh />
          <span className="who">
            {viewer.name} ({viewer.role})
          </span>
          {viewer.role === 'admin' && (
            <a href="/dashboard/team" className="action-btn">
              Team &amp; Permissions
            </a>
          )}
          <form action={logout}>
            <button type="submit" className="action-btn">
              Log out
            </button>
          </form>
        </div>
      </header>

      <section className="cards">
        <div className="metric">
          <span className="metric-label">Commission today</span>
          <span className="metric-value">{usd(summary.commissionToday)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Volume today</span>
          <span className="metric-value">{usd(summary.volumeToday)}</span>
        </div>
        <div className="metric">
          <span className="metric-label">Transactions today</span>
          <span className="metric-value">{summary.countToday}</span>
        </div>
        <div className="metric metric-attention">
          <span className="metric-label">Needs attention</span>
          <span className="metric-value">{summary.needsAttention}</span>
        </div>
        <div className="metric metric-small">
          <span className="metric-label">All-time commission</span>
          <span className="metric-value">{usd(summary.commissionAllTime)}</span>
        </div>
      </section>

      <section className="attention">
        <h2>Needs Attention</h2>
        {abandoned.length === 0 ? (
          <p className="nothing-attention">Nothing needs attention right now.</p>
        ) : (
          <ul className="attention-list">
            {abandoned.map((t) => (
              <li key={t.id} className="attention-item">
                <span className="attention-id">{t.id}</span>
                <span className="attention-name">{t.recipientName}</span>
                <span className="attention-amount">{usd(t.amountUsd)}</span>
                <span className="attention-age">
                  Created {new Date(t.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ledger-section">
        <h2>All Transactions</h2>
        {transfers.length === 0 ? (
          <p className="empty-state">No transactions yet.</p>
        ) : (
          <div className="ledger-wrapper">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Recipient</th>
                  <th>Amount</th>
                  <th>→ INR</th>
                  <th>Fee</th>
                  <th>Funding</th>
                  <th>Payout</th>
                  <th>US Payment</th>
                  <th>India Delivery</th>
                  <th>Status</th>
                  <th>Assignee</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr
                    key={t.id}
                    className={isAbandoned(t, now) ? 'row-abandoned' : ''}
                  >
                    <td>{new Date(t.createdAt).toLocaleString()}</td>
                    <td>{t.recipientName}</td>
                    <td>{usd(t.amountUsd)}</td>
                    <td>{inr(t.amountInr)}</td>
                    <td>{usd(t.feeUsd)}</td>
                    <td>{humanizeFunding(t.fundingMethod)}</td>
                    <td>{t.payoutMethod.toUpperCase()}</td>
                    <td>
                      <Stage at={t.paidAt} fallback="pending" />
                    </td>
                    <td>
                      <Stage
                        at={t.deliveredAt}
                        fallback={t.status === 'paid' ? 'in transit' : '—'}
                      />
                    </td>
                    <td>
                      <StatusBadge status={t.status} />
                    </td>
                    <td>
                      {t.assignedTo
                        ? staffByUsername.get(t.assignedTo) ?? t.assignedTo
                        : '—'}
                    </td>
                    <td>
                      <TransferActions
                        transfer={t}
                        viewer={viewer}
                        staff={staff}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Run the suite and build**

Run: `npm test`
Expected: PASS — all green.
Run: `npm run build`
Expected: PASS — `/dashboard` compiles.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/page.tsx src/app/dashboard/actions.ts
git commit -m "feat: gate dashboard with auth and permission-aware actions"
```

---

## Task 10: Team & Permissions page (admin-only)

**Files:**
- Create: `src/app/dashboard/team/actions.ts`
- Create: `src/app/dashboard/team/page.tsx`

- [ ] **Step 1: Create `src/app/dashboard/team/actions.ts`**

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { getAuthStore } from '@/lib/auth-store';
import { requireAdmin } from '@/lib/auth';
import { hashPassword } from '@/lib/password';
import type { Staff } from '@/lib/types';

function readPermissions(formData: FormData) {
  return {
    canCancel: formData.get('canCancel') === 'on',
    canResend: formData.get('canResend') === 'on',
    canAssign: formData.get('canAssign') === 'on',
  };
}

export async function addStaffAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!username || !name || !password) {
    throw new Error('Name, username, and password are all required.');
  }
  const store = getAuthStore();
  if (await store.getStaff(username)) {
    throw new Error('That username already exists.');
  }
  const staff: Staff = {
    username,
    name,
    role: 'agent',
    permissions: readPermissions(formData),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  await store.saveStaff(staff);
  revalidatePath('/dashboard/team');
}

export async function updatePermissionsAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const username = String(formData.get('username') ?? '');
  const store = getAuthStore();
  const staff = await store.getStaff(username);
  if (!staff) throw new Error('Staff member not found.');
  if (staff.role === 'admin') return; // admins always have all permissions
  staff.permissions = readPermissions(formData);
  await store.saveStaff(staff);
  revalidatePath('/dashboard/team');
}

export async function removeStaffAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const username = String(formData.get('username') ?? '');
  const store = getAuthStore();
  const staff = await store.getStaff(username);
  if (!staff) return;
  if (staff.role === 'admin') {
    throw new Error('Admin accounts cannot be removed here.');
  }
  await store.deleteStaff(username);
  revalidatePath('/dashboard/team');
}
```

- [ ] **Step 2: Create `src/app/dashboard/team/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import { getAuthStore } from '@/lib/auth-store';
import { requireAdmin } from '@/lib/auth';
import {
  addStaffAction,
  updatePermissionsAction,
  removeStaffAction,
} from './actions';
import type { Staff } from '@/lib/types';

function PermissionCheckbox({
  name,
  label,
  checked,
}: {
  name: string;
  label: string;
  checked: boolean;
}) {
  return (
    <label className="perm">
      <input type="checkbox" name={name} defaultChecked={checked} /> {label}
    </label>
  );
}

function StaffRow({ staff }: { staff: Staff }) {
  if (staff.role === 'admin') {
    return (
      <tr>
        <td>{staff.name}</td>
        <td>{staff.username}</td>
        <td>admin</td>
        <td colSpan={2}>Full access (all permissions)</td>
      </tr>
    );
  }
  return (
    <tr>
      <td>{staff.name}</td>
      <td>{staff.username}</td>
      <td>agent</td>
      <td>
        <form action={updatePermissionsAction} className="perm-form">
          <input type="hidden" name="username" value={staff.username} />
          <PermissionCheckbox
            name="canCancel"
            label="Cancel/refund"
            checked={staff.permissions.canCancel}
          />
          <PermissionCheckbox
            name="canResend"
            label="Resend link"
            checked={staff.permissions.canResend}
          />
          <PermissionCheckbox
            name="canAssign"
            label="Assign"
            checked={staff.permissions.canAssign}
          />
          <button type="submit" className="action-btn">
            Save
          </button>
        </form>
      </td>
      <td>
        <form action={removeStaffAction}>
          <input type="hidden" name="username" value={staff.username} />
          <button type="submit" className="action-btn cancel-btn">
            Remove
          </button>
        </form>
      </td>
    </tr>
  );
}

export default async function TeamPage() {
  await requireAdmin();
  const staff = await getAuthStore().listStaff();

  return (
    <main className="dashboard">
      <header className="dash-header">
        <h1 className="dashboard-title">Team &amp; Permissions</h1>
        <a href="/dashboard" className="action-btn">
          ← Back to dashboard
        </a>
      </header>

      <section className="ledger-section">
        <h2>Staff</h2>
        <div className="ledger-wrapper">
          <table className="ledger">
            <thead>
              <tr>
                <th>Name</th>
                <th>Username</th>
                <th>Role</th>
                <th>Permissions</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <StaffRow key={s.username} staff={s} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="attention">
        <h2>Add a team agent</h2>
        <form action={addStaffAction} className="add-staff-form">
          <input name="name" placeholder="Full name" required />
          <input name="username" placeholder="Username" required />
          <input
            name="password"
            type="password"
            placeholder="Password"
            required
          />
          <div className="perm-row">
            <PermissionCheckbox
              name="canCancel"
              label="Cancel/refund"
              checked={false}
            />
            <PermissionCheckbox
              name="canResend"
              label="Resend link"
              checked={false}
            />
            <PermissionCheckbox
              name="canAssign"
              label="Assign"
              checked={false}
            />
          </div>
          <button type="submit" className="action-btn assign-btn">
            Add agent
          </button>
        </form>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Run the suite and build**

Run: `npm test`
Expected: PASS — all green.
Run: `npm run build`
Expected: PASS — `/dashboard/team` route compiles.

- [ ] **Step 4: Commit**

```bash
git add "src/app/dashboard/team"
git commit -m "feat: add admin Team & Permissions page"
```

---

## Task 11: Styles + full verification

**Files:**
- Modify: `src/app/globals.css`

- [ ] **Step 1: Append dashboard/login/team styles to `src/app/globals.css`**

```css
.dash-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 20px;
}
.dash-header-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.who { color: #8696a0; font-size: 13px; }
.login-form { display: flex; flex-direction: column; gap: 14px; }
.login-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #8696a0; }
.login-form input {
  padding: 10px; background: #2a3942; border: 1px solid #2a3942;
  border-radius: 8px; color: #e9edef; font-size: 15px;
}
.perm-form, .add-staff-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.add-staff-form input {
  padding: 8px; background: #2a3942; border: 1px solid #2a3942;
  border-radius: 8px; color: #e9edef; font-size: 14px;
}
.perm, .perm-row { font-size: 13px; color: #e9edef; display: inline-flex; gap: 6px; align-items: center; }
.perm-row { gap: 16px; }
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — every test file green.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: PASS — compiles with no type errors; routes `/login`, `/dashboard`, `/dashboard/team` all listed; middleware reported.

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css
git commit -m "style: add login, team, and dashboard header styles"
```

---

## Manual Verification (after deployment)

1. Set `SEED_ADMIN_USERNAME` and `SEED_ADMIN_PASSWORD` env vars on Vercel; deploy.
2. Visit `/dashboard` → redirected to `/login`.
3. Log in with the seed admin → dashboard loads, header shows your name + "admin".
4. Open **Team & Permissions** → add an agent with only "Resend link" checked.
5. Log out; log in as that agent → dashboard shows only the Resend action; no Cancel/Assign buttons; no Team link.
6. Confirm a webhook still works (message the bot) and `/pay/...` is still reachable — middleware must not gate them.

---

## Self-Review Notes

- **Spec coverage:** Part A concurrency (Tasks 1–2); staff accounts + hashing (Tasks 3, 5); sessions + cookie (Tasks 4, 5, 8); middleware gate (Task 8); seeded admin (Tasks 4, 6); login/logout (Task 8); roles + per-agent permissions enforced in UI and server actions (Tasks 6, 9); admin Team page managing permissions (Task 10). All covered.
- **Type consistency:** `Staff`, `StaffRole`, `StaffPermissions` defined once (Task 4) and reused; `AuthStore` from `createAuthStore`; `hasPermission(staff, keyof StaffPermissions)` used identically in Tasks 9 and 10; `getTransferCount`/`incrementTransferCount` signatures consistent between Task 2 definition and `tools.ts` callers.
- **Public routes:** middleware matcher is `['/dashboard', '/dashboard/:path*']` only — `/api/whatsapp`, `/api/pay/*`, `/pay/*`, `/login`, `/` stay public.
- **No placeholders:** every step contains complete code or an exact command.
