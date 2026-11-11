import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import { createSanctionsListRepo } from '@/db/repos/sanctions-list-repo';
import {
  runOfacSdnLoad,
  runListLoad,
  easternDay,
  SANCTIONS_LOAD_AUDIT_ACTION,
  OFAC_SDN_MIN_ENTRIES,
  type ListLoadDef,
} from '@/lib/sanctions/list-loader';
import { hashEntries } from '@/lib/sanctions/ofac-sdn-loader';
import type { SanctionsList } from '@/lib/sanctions/list-source';
import { fetchUnScList, UN_SC_MIN_ENTRIES } from '@/lib/sanctions/un-sc-loader';

// Program-Fix 14 PR C: the daily OFAC SDN loader. Tests never touch the
// network: fetch is always a stub returning the checked-in fixture.

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8');
const UN_FIXTURE = readFileSync(join(__dirname, 'fixtures', 'un-sc-sample.xml'), 'utf8');
const NOW = Date.parse('2026-09-23T13:00:00Z');

const okFetch = (body = FIXTURE) =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => body,
    // L1-LF3: the new loaders read a body-less stub through arrayBuffer (pinned-fetch.ts); SDN still reads text().
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  })) as unknown as typeof fetch;
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
    const res = await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: okFetch(), now: NOW });
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
    await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: okFetch(), now: NOW });
    const res = await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: okFetch(), now: NOW + 4 * 3600_000 });
    expect(res.status).toBe('unchanged');
  });

  it('a network failure fails SOFT: keeps the last good version, raises ONE ops alert per day, never throws', async () => {
    await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: okFetch(), now: NOW });
    const first = await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: failFetch(503), now: NOW + 86_400_000 });
    const again = await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: failFetch(503), now: NOW + 86_400_000 + 4 * 3600_000 });
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
    await expect(runOfacSdnLoad({ db, minEntries: 1, fetchImpl: boom, now: NOW })).resolves.toMatchObject({ status: 'failed', reason: 'fetch' });
    expect(await alerts(db)).toHaveLength(1);
  });

  it('an unparseable document is refused (reason parse) and never becomes an empty "clean" list', async () => {
    const res = await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: okFetch('<html>maintenance</html>'), now: NOW });
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
    await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: okFetch(big), now: NOW });
    const res = await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: okFetch(FIXTURE.replace('09/18/2026', '09/22/2026')), now: NOW + 86_400_000 });
    expect(res).toMatchObject({ status: 'failed', reason: 'shrink' });
    expect((await createSanctionsListRepo(db).activeVersion('ofac-sdn'))!.entryCount).toBe(25);
    expect(await alerts(db)).toHaveLength(1);
  });

  it('an older publication is refused (reason stale) and alerts', async () => {
    await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: okFetch(), now: NOW });
    const older = FIXTURE.replace('09/18/2026', '09/01/2026').replace('SEA FIXTURE', 'SEA FIXTURE TWO');
    const res = await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: okFetch(older), now: NOW + 86_400_000 });
    expect(res).toMatchObject({ status: 'failed', reason: 'stale' });
    expect(await alerts(db)).toHaveLength(1);
  });

  it('production floor: the real loader refuses a list with too few entries', async () => {
    const res = await runOfacSdnLoad({ db, fetchImpl: okFetch(), now: NOW, minEntries: OFAC_SDN_MIN_ENTRIES });
    expect(OFAC_SDN_MIN_ENTRIES).toBeGreaterThanOrEqual(5000);
    expect(res).toMatchObject({ status: 'failed', reason: 'shrink' });
  });

  it('still returns the failure when even the alert cannot be written', async () => {
    const res = await runOfacSdnLoad({
      db,
      minEntries: 1,
      fetchImpl: failFetch(500),
      now: NOW,
      enqueueAlert: async () => { throw new Error('outbox down'); },
    });
    expect(res).toMatchObject({ status: 'failed', reason: 'fetch' });
  });
});

// Fix pack 5 T26 (P27): the generic per-source loader. The def's fetch is a
// stub returning a hand-built list with INVENTED names; nothing touches the network.
describe('runListLoad', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  const entry = (i: number) => ({ id: `cons:${900 + i}`, names: [`INVENTED CONS ${i}`], type: 'Entity', programs: ['X'] });
  const stubList = (n = 4, version = '2026-09-18'): SanctionsList => {
    const entries = Array.from({ length: n }, (_, i) => entry(i));
    return { source: 'ofac-cons', version, hash: hashEntries(entries), entries };
  };
  const def = (fetchFn: () => Promise<SanctionsList>, o: Partial<ListLoadDef> = {}): ListLoadDef => ({
    source: 'ofac-cons',
    label: 'OFAC consolidated (non-SDN)',
    minEntries: 3,
    parseErrorPrefix: 'OFAC CONS:',
    fetch: fetchFn,
    ...o,
  });

  it('activated, then unchanged on the same list; audit meta source ofac-cons', async () => {
    const first = await runListLoad({ db, now: NOW }, def(async () => stubList()));
    expect(first).toMatchObject({ status: 'activated', version: '2026-09-18', entryCount: 4 });
    const second = await runListLoad({ db, now: NOW + 3600_000 }, def(async () => stubList()));
    expect(second.status).toBe('unchanged');
    expect((await createSanctionsListRepo(db).activeVersion('ofac-cons'))!.version).toBe('2026-09-18');
    const rows = await audits(db);
    expect(rows.map((r) => r.meta.source)).toEqual(['ofac-cons', 'ofac-cons']);
    expect(rows.map((r) => r.meta.status)).toEqual(['activated', 'unchanged']);
    expect(JSON.stringify(rows.map((r) => r.meta))).not.toMatch(/INVENTED/);
    expect(await alerts(db)).toHaveLength(0);
  });

  it('a fetch error -> failed fetch, ONE alert keyed per source and Eastern day; the SDN key is untouched', async () => {
    const boom = def(async () => { throw new TypeError('fetch failed'); });
    const a = await runListLoad({ db, now: NOW }, boom);
    const b = await runListLoad({ db, now: NOW + 4 * 3600_000 }, boom);
    expect(a).toEqual({ status: 'failed', reason: 'fetch' });
    expect(b).toEqual({ status: 'failed', reason: 'fetch' });
    const rows = await alerts(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(`sanctions-list-load-failed:ofac-cons:${easternDay(NOW)}`);
    expect(rows.some((r) => r.dedupe_key.includes(':ofac-sdn:'))).toBe(false);
    expect((await audits(db)).map((r) => r.meta)).toEqual([
      { source: 'ofac-cons', status: 'failed', reason: 'fetch' },
      { source: 'ofac-cons', status: 'failed', reason: 'fetch' },
    ]);
  });

  it("an error whose message starts with the def's parseErrorPrefix -> parse", async () => {
    const res = await runListLoad({ db, now: NOW }, def(async () => { throw new Error('OFAC CONS: no entries parsed'); }));
    expect(res).toEqual({ status: 'failed', reason: 'parse' });
    // Another source's prefix is not a parse error for this def.
    const other = await runListLoad({ db, now: NOW }, def(async () => { throw new Error('OFAC SDN: no entries parsed'); }));
    expect(other).toEqual({ status: 'failed', reason: 'fetch' });
    expect(await createSanctionsListRepo(db).activeVersion('ofac-cons')).toBeNull();
  });

  it('shrink and stale map as for SDN; the def floor applies unless deps override it', async () => {
    expect(await runListLoad({ db, now: NOW }, def(async () => stubList(2)))).toEqual({ status: 'failed', reason: 'shrink' });
    expect((await runListLoad({ db, now: NOW, minEntries: 1 }, def(async () => stubList(2)))).status).toBe('activated');
    expect(await runListLoad({ db, now: NOW }, def(async () => stubList(4, '2026-09-01')))).toEqual({ status: 'failed', reason: 'stale' });
    expect((await createSanctionsListRepo(db).activeVersion('ofac-cons'))!.version).toBe('2026-09-18');
  });

  it('the generic alert text names the label and never a list entry', async () => {
    await runListLoad({ db, now: NOW }, def(async () => stubList(2)));
    const [row] = await alerts(db);
    const day = easternDay(NOW);
    expect(row.payload.message).toBe(
      `⚠️ SmartRemit ops: the OFAC consolidated (non-SDN) list load failed on ${day} ` +
        '(the downloaded list has too few entries (against the minimum or the last stored version) and was refused). ' +
        'Screening keeps using the last good loaded version of this list (under SANCTIONS_LIST=lists a list that was ' +
        'never loaded holds every transfer for review). The 17:00 UTC cron run retries automatically; check the ' +
        "'sanctions.list.load' audit rows for the cause.",
    );
    expect(row.payload.message).not.toMatch(/INVENTED|Treasury Sanctions List Service|SDN list/);
  });

  it('a def alertText replaces the generic text', async () => {
    await runListLoad({ db, now: NOW }, def(async () => { throw new Error('x'); }, { alertText: (day, reason) => `custom ${day} ${reason}` }));
    expect((await alerts(db))[0].payload.message).toBe(`custom ${easternDay(NOW)} fetch`);
  });

  it('the alert write failing still returns the failure', async () => {
    const res = await runListLoad(
      { db, now: NOW, enqueueAlert: async () => { throw new Error('outbox down'); } },
      def(async () => { throw new Error('x'); }),
    );
    expect(res).toEqual({ status: 'failed', reason: 'fetch' });
  });

  it("pack 5 T27: the un-sc def - a parse error prefixed 'UN SC:' -> parse; one alert sanctions-list-load-failed:un-sc:<easternDay>", async () => {
    const unDef = (fetchFn: () => Promise<SanctionsList>): ListLoadDef => ({
      source: 'un-sc',
      label: 'UN Security Council',
      minEntries: UN_SC_MIN_ENTRIES,
      parseErrorPrefix: 'UN SC:',
      fetch: fetchFn,
    });
    const bad = unDef(() => fetchUnScList(okFetch(UN_FIXTURE.replace('</CONSOLIDATED_LIST>', ''))));
    expect(await runListLoad({ db, now: NOW }, bad)).toEqual({ status: 'failed', reason: 'parse' });
    expect(await runListLoad({ db, now: NOW + 3600_000 }, bad)).toEqual({ status: 'failed', reason: 'parse' });
    // A fetch error ('UN SC fetch failed: ...') is not a parse error.
    expect(await runListLoad({ db, now: NOW }, unDef(() => fetchUnScList(failFetch(503))))).toEqual({ status: 'failed', reason: 'fetch' });
    const rows = await alerts(db);
    expect(rows.map((r) => r.dedupe_key)).toEqual([`sanctions-list-load-failed:un-sc:${easternDay(NOW)}`]);
    expect(rows[0].payload.message).toContain('the UN Security Council list load failed');
    expect(await createSanctionsListRepo(db).activeVersion('un-sc')).toBeNull();
  });

  // Pack 5 T30 (P33): the cron's store mutex wraps ONLY the store step; the
  // fetch runs before it. Absent = direct (every other caller unchanged).
  it('pack 5 T30: serialStore wraps only the store step (fetch outside it); runOfacSdnLoad passes it through', async () => {
    const steps: string[] = [];
    const serialStore = async <T,>(fn: () => Promise<T>): Promise<T> => {
      steps.push('enter');
      const r = await fn();
      steps.push('leave');
      return r;
    };
    const res = await runListLoad({ db, now: NOW, serialStore }, def(async () => { steps.push('fetch'); return stubList(); }));
    expect(res.status).toBe('activated');
    expect(steps).toEqual(['fetch', 'enter', 'leave']);
    // A failed fetch never takes the store lock.
    steps.length = 0;
    await runListLoad({ db, now: NOW, serialStore }, def(async () => { steps.push('fetch'); throw new Error('x'); }));
    expect(steps).toEqual(['fetch']);
    steps.length = 0;
    expect((await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: okFetch(), now: NOW, serialStore })).status).toBe('activated');
    expect(steps).toEqual(['enter', 'leave']);
  });

  it('two sources failing on one day -> two alerts (keys differ)', async () => {
    await runListLoad({ db, now: NOW }, def(async () => { throw new Error('x'); }));
    await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: failFetch(503), now: NOW });
    const keys = (await alerts(db)).map((r) => r.dedupe_key).sort();
    expect(keys).toEqual([
      `sanctions-list-load-failed:ofac-cons:${easternDay(NOW)}`,
      `sanctions-list-load-failed:ofac-sdn:${easternDay(NOW)}`,
    ]);
  });
});

describe('runOfacSdnLoad alert text (pack 5 T26: byte-identical through runListLoad)', () => {
  it('keeps the SDN wording exactly', async () => {
    const db = await freshDb();
    await runOfacSdnLoad({ db, minEntries: 1, fetchImpl: okFetch('<html>maintenance</html>'), now: NOW });
    const [row] = await alerts(db);
    expect(row.dedupe_key).toBe('sanctions-list-load-failed:ofac-sdn:2026-09-23');
    expect(row.payload.message).toBe(
      '⚠️ SmartRemit ops: the OFAC SDN list load failed on 2026-09-23 (the downloaded file did not parse as the SDN list). ' +
        'Screening keeps using the last good loaded version (if SANCTIONS_LIST=ofac-sdn and none was ever loaded, ' +
        'every transfer goes to manual review). The 17:00 UTC cron run retries automatically; check the ' +
        "'sanctions.list.load' audit rows for the cause.",
    );
    expect((await audits(db))[0].meta).toEqual({ source: 'ofac-sdn', status: 'failed', reason: 'parse' });
  });
});
