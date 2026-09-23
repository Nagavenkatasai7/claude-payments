import { describe, it, expect, vi } from 'vitest';
import { freshDb } from './helpers-db';
import { createAuditRepo, type AuditEvent } from '@/db/repos/aux-repos';
import { createStaffAuthAudit, staffIpHash } from '@/lib/staff-auth-audit';

// Program-Fix 17a — auth.* audit rows are best-effort AND time-bounded: a
// Neon outage (throw or hang) must never block a Redis-only staff login.

const KEY = Buffer.alloc(32, 7);

describe('staff-auth-audit', () => {
  it('writes an auth.* row with a keyed ipHash (never the raw IP)', async () => {
    const db = await freshDb();
    const audit = createStaffAuthAudit({ record: (e) => createAuditRepo(db).record(e), ipKey: () => KEY });
    await audit.record({ action: 'auth.login', actorType: 'staff', actor: 'ops', subjectId: 'ops', partnerId: 'acme', ip: '203.0.113.9' });
    const rows = await createAuditRepo(db).listRecent(5);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'auth.login', actorType: 'staff', actor: 'ops', subjectId: 'ops', partnerId: 'acme' });
    const meta = rows[0].meta as Record<string, unknown>;
    expect(meta.ipHash).toBe(staffIpHash('203.0.113.9', KEY));
    expect(JSON.stringify(rows[0])).not.toContain('203.0.113.9');
  });

  it('the ipHash is keyed: a different key gives a different hash', () => {
    expect(staffIpHash('1.2.3.4', KEY)).not.toBe(staffIpHash('1.2.3.4', Buffer.alloc(32, 8)));
  });

  it('audit insert throws → record resolves (best-effort), warning carries no username', async () => {
    const warn = vi.fn();
    const audit = createStaffAuthAudit({
      record: async () => {
        throw new Error('neon down');
      },
      ipKey: () => KEY,
      warn,
    });
    await expect(
      audit.record({ action: 'auth.login.failed', actorType: 'system', actor: 'login', ip: '1.2.3.4' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('1.2.3.4');
  });

  it('audit insert hangs → record resolves at the deadline', async () => {
    const warn = vi.fn();
    const audit = createStaffAuthAudit({
      record: () => new Promise<void>(() => {}),
      ipKey: () => KEY,
      timeoutMs: 30,
      warn,
    });
    const t = Date.now();
    await audit.record({ action: 'auth.login', actorType: 'staff', actor: 'ops', subjectId: 'ops', ip: '1.2.3.4' });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a missing ip key omits ipHash but still writes the row', async () => {
    const rows: AuditEvent[] = [];
    const audit = createStaffAuthAudit({
      record: async (e) => {
        rows.push(e);
      },
      ipKey: () => {
        throw new Error('no key');
      },
    });
    await audit.record({ action: 'auth.logout', actorType: 'staff', actor: 'ops', subjectId: 'ops', ip: '1.2.3.4' });
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({});
  });
});
