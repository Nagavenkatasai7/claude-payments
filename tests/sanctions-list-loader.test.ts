import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { createSanctionsListRepo } from '@/db/repos/sanctions-list-repo';
import { runOfacSdnLoad, SANCTIONS_LOAD_AUDIT_ACTION } from '@/lib/sanctions/list-loader';

// Program-Fix 14 PR C: the daily OFAC SDN loader. Tests never touch the
// network: fetch is always a stub returning the checked-in fixture.

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8');
const NOW = Date.parse('2026-09-23T13:00:00Z');

const okFetch = (body = FIXTURE) =>
  vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => body })) as unknown as typeof fetch;
const failFetch = (status = 503) =>
  vi.fn(async () => ({ ok: false, status, headers: new Headers(), text: async () => '' })) as unknown as typeof fetch;

type Rows<T> = { rows: T[] };
async function audits(db: Db) {
  const r = await db.execute(sql`SELECT actor, actor_type, action, meta FROM audit_events WHERE action = ${SANCTIONS_LOAD_AUDIT_ACTION} ORDER BY id`);
  return (r as unknown as Rows<{ actor: string; actor_type: string; action: string; meta: Record<string, unknown> }>).rows;
}
async function alerts(db: Db) {
  const r = await db.execute(sql`SELECT kind, payload, dedupe_key FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
  return (r as unknown as Rows<{ kind: string; payload: { message: string }; dedupe_key: string }>).rows;
}

describe('runOfacSdnLoad', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('fetches, stores and activates the list, and writes one audit row (counts + hash, no names)', async () => {
    const res = await runOfacSdnLoad({ db, fetchImpl: okFetch(), now: NOW });
    expect(res).toMatchObject({ status: 'activated', version: '2026-09-18', entryCount: 5 });
    expect((await createSanctionsListRepo(db).activeVersion('ofac-sdn'))!.version).toBe('2026-09-18');
    const rows = await audits(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'system:sanctions', actor_type: 'system' });
    expect(rows[0].meta).toMatchObject({ source: 'ofac-sdn', status: 'activated', version: '2026-09-18', entryCount: 5 });
    expect(JSON.stringify(rows[0].meta)).not.toMatch(/FIXTURELLI|EXAMPLE AIRWAYS/i);
    expect(await alerts(db)).toHaveLength(0);
  });

  it('a second run on the same list is "unchanged" (no new version)', async () => {
    await runOfacSdnLoad({ db, fetchImpl: okFetch(), now: NOW });
    const res = await runOfacSdnLoad({ db, fetchImpl: okFetch(), now: NOW + 4 * 3600_000 });
    expect(res.status).toBe('unchanged');
  });

  it('a network failure fails SOFT: keeps the last good version, raises ONE ops alert per day, never throws', async () => {
    await runOfacSdnLoad({ db, fetchImpl: okFetch(), now: NOW });
    const first = await runOfacSdnLoad({ db, fetchImpl: failFetch(503), now: NOW + 86_400_000 });
    const again = await runOfacSdnLoad({ db, fetchImpl: failFetch(503), now: NOW + 86_400_000 + 4 * 3600_000 });
    expect(first).toMatchObject({ status: 'failed', reason: 'fetch' });
    expect(again).toMatchObject({ status: 'failed', reason: 'fetch' });
    expect((await createSanctionsListRepo(db).activeVersion('ofac-sdn'))!.version).toBe('2026-09-18');
    const a = await alerts(db);
    expect(a).toHaveLength(1);
    expect(a[0].dedupe_key).toBe('sanctions-list-load-failed:ofac-sdn:2026-09-24');
    expect(a[0].payload.message).toMatch(/OFAC SDN/);
    expect(a[0].payload.message).toMatch(/last good/i);
    // Each attempt still leaves its own audit row.
    expect((await audits(db)).map((r) => r.meta.status)).toEqual(['activated', 'failed', 'failed']);
  });

  it('a thrown fetch (DNS, timeout) fails soft the same way', async () => {
    const boom = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(runOfacSdnLoad({ db, fetchImpl: boom, now: NOW })).resolves.toMatchObject({ status: 'failed', reason: 'fetch' });
    expect(await alerts(db)).toHaveLength(1);
  });

  it('an unparseable document is refused (reason parse) and never becomes an empty "clean" list', async () => {
    const res = await runOfacSdnLoad({ db, fetchImpl: okFetch('<html>maintenance</html>'), now: NOW });
    expect(res).toMatchObject({ status: 'failed', reason: 'parse' });
    expect(await createSanctionsListRepo(db).activeVersion('ofac-sdn')).toBeNull();
  });

  it('a list that shrank sharply is refused (reason shrink) and the last good stays active', async () => {
    const big = FIXTURE.replace(
      '</sdnList>',
      Array.from({ length: 20 }, (_, i) =>
        `<sdnEntry><uid>${5000 + i}</uid><lastName>SYNTHETIC ${i}</lastName><sdnType>Entity</sdnType><programList><program>X</program></programList></sdnEntry>`,
      ).join('') + '</sdnList>',
    );
    await runOfacSdnLoad({ db, fetchImpl: okFetch(big), now: NOW });
    const res = await runOfacSdnLoad({ db, fetchImpl: okFetch(FIXTURE.replace('09/18/2026', '09/22/2026')), now: NOW + 86_400_000 });
    expect(res).toMatchObject({ status: 'failed', reason: 'shrink' });
    expect((await createSanctionsListRepo(db).activeVersion('ofac-sdn'))!.entryCount).toBe(25);
    expect(await alerts(db)).toHaveLength(1);
  });

  it('still returns the failure when even the alert cannot be written', async () => {
    const res = await runOfacSdnLoad({
      db,
      fetchImpl: failFetch(500),
      now: NOW,
      enqueueAlert: async () => { throw new Error('outbox down'); },
    });
    expect(res).toMatchObject({ status: 'failed', reason: 'fetch' });
  });
});
