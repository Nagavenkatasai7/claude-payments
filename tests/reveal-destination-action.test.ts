import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { createStore } from '@/lib/store';
import { auditEvents } from '@/db/schema';
import type { Db } from '@/db/client';
import type { Staff, Transfer } from '@/lib/types';

/**
 * Program-Fix 45 P1 (authz-06): revealing a full payout destination is its own
 * permission (`canRevealPii`). Admins (platform and partner) keep it through the
 * admin bypass; support and agents need the explicit grant. A caller without it
 * gets the SAME `{ error: 'Transfer not found' }` as a missing or out-of-scope
 * transfer, nothing is decrypted, and no audit row is written.
 */

const redis = fakeRedis();
let currentStaff: Staff;
let db: Db;
let store: ReturnType<typeof createStore>;

vi.mock('@/lib/auth', () => ({
  requireStaff: async () => currentStaff,
  requireAdmin: async () => currentStaff,
  requirePlatformAdmin: vi.fn(),
  requireScope: async () => ({ staff: currentStaff }),
  getCurrentStaff: vi.fn(),
}));
vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client');
  return { ...actual, getDb: () => db };
});
vi.mock('@/lib/whatsapp', () => ({ sendText: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { revealDestinationAction } from '@/app/admin-dashboard/actions';

const DEST = 'acct 000111222333';

function staff(overrides: Partial<Staff>): Staff {
  return {
    username: 'u',
    name: 'U',
    role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeTransfer(overrides: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15550000001',
    amountUsd: 200,
    feeUsd: 0,
    totalChargeUsd: 200,
    fxRate: 85,
    amountInr: 17000,
    recipientName: 'R',
    recipientPhone: '915550000002',
    payoutMethod: 'bank',
    payoutDestination: DEST,
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: new Date().toISOString(),
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'A',
    amountSource: 200,
    feeSource: 0,
    totalChargeSource: 200,
    ...overrides,
  };
}

async function revealRows() {
  return (await db.select().from(auditEvents)).filter((r) => r.action === 'pii.reveal');
}

beforeEach(async () => {
  redis.dump.clear();
  db = await freshDb();
  await seedPartner(db, 'A');
  await seedPartner(db, 'B');
  store = createStore(redis, db);
  await store.saveTransfer(makeTransfer({ id: 't1', partnerId: 'A' }));
});

describe('revealDestinationAction requires canRevealPii (Program-Fix 45 P1)', () => {
  it('a platform admin reveals and the reveal is audited', async () => {
    currentStaff = staff({ username: 'plat' });
    expect(await revealDestinationAction('t1')).toEqual({ destination: DEST });
    const rows = await revealRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'plat', subjectId: 't1', partnerId: 'A' });
  });

  it('a partner admin reveals their own tenant’s transfer', async () => {
    currentStaff = staff({ username: 'pa', partnerId: 'A' });
    expect(await revealDestinationAction('t1')).toEqual({ destination: DEST });
  });

  it('support staff get the generic not-found shape, and nothing is audited', async () => {
    currentStaff = staff({
      username: 'sup',
      role: 'support',
      permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: false },
    });
    expect(await revealDestinationAction('t1')).toEqual({ error: 'Transfer not found' });
    expect(await revealRows()).toHaveLength(0);
  });

  it('support staff stay refused even if a stored record carries the flag', async () => {
    currentStaff = staff({
      username: 'sup2',
      role: 'support',
      permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: true },
    });
    // Team actions force SUPPORT_DEFAULT_PERMISSIONS, so a stored `true` can
    // only come from a hand-edited record; the role check refuses it anyway.
    expect(await revealDestinationAction('t1')).toEqual({ error: 'Transfer not found' });
    expect(await revealRows()).toHaveLength(0);
  });

  it('an agent without the grant gets the generic not-found shape', async () => {
    currentStaff = staff({ username: 'ag', role: 'agent' });
    expect(await revealDestinationAction('t1')).toEqual({ error: 'Transfer not found' });
    expect(await revealRows()).toHaveLength(0);
  });

  it('an agent with the grant reveals, with one pii.reveal row', async () => {
    currentStaff = staff({
      username: 'ag2',
      role: 'agent',
      permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: true },
    });
    expect(await revealDestinationAction('t1')).toEqual({ destination: DEST });
    const rows = await revealRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'ag2', actorType: 'staff', meta: { field: 'payout_destination' } });
  });

  it('an agent with the grant but another tenant gets not-found, no audit row', async () => {
    currentStaff = staff({
      username: 'ag3',
      role: 'agent',
      partnerId: 'B',
      permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: true },
    });
    expect(await revealDestinationAction('t1')).toEqual({ error: 'Transfer not found' });
    expect(await revealRows()).toHaveLength(0);
  });
});
