import { describe, it, expect } from 'vitest';
import { fakeRedis } from './helpers';
import { createAuditLogStore, type StaffAuditEntry } from '@/lib/audit-log-store';

function entry(i: number): StaffAuditEntry {
  return { at: `2026-06-0${(i % 9) + 1}T00:00:00Z`, actor: 'boss', action: 'created', target: `u${i}` };
}

describe('audit-log-store', () => {
  it('records newest-first and lists them', async () => {
    const s = createAuditLogStore(fakeRedis());
    await s.record(entry(1));
    await s.record(entry(2));
    const log = await s.list();
    expect(log).toHaveLength(2);
    expect(log[0].target).toBe('u2'); // newest first
    expect(log[1].target).toBe('u1');
  });

  it('caps the stored history at 200', async () => {
    const s = createAuditLogStore(fakeRedis());
    for (let i = 0; i < 210; i++) await s.record(entry(i));
    const log = await s.list(1000);
    expect(log).toHaveLength(200);
    expect(log[0].target).toBe('u209'); // most recent retained
  });

  it('respects the list limit', async () => {
    const s = createAuditLogStore(fakeRedis());
    for (let i = 0; i < 10; i++) await s.record(entry(i));
    expect(await s.list(3)).toHaveLength(3);
  });

  it('returns an empty array when there is no history', async () => {
    const s = createAuditLogStore(fakeRedis());
    expect(await s.list()).toEqual([]);
  });
});
