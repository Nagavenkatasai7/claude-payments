import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { signInAs } from './helpers-partner-app';
import type { Db } from '@/db/client';
import type { Staff } from '@/lib/types';

// Fix pack 5 T31 (R08, P28, P29): the platform-only India MHA upload and "confirm still current".
// Order: the site-host guard, requirePlatformAdmin, the actor's own staff MFA, the bounds and the
// parser (a refusal from here on is audited 'refused', counts and codes only), the step-up
// (ALWAYS), storeList, the audit row. Every name below is invented.

const redis = fakeRedis();
let db: Db;
const cookieJar = new Map<string, string>();
let host = 'smartremit.ai';
const staffMfa = vi.hoisted(() => ({ enrolled: new Set<string>() }));
const gate = vi.hoisted(() => ({ bypass: false, calls: [] as Array<{ target: string; always: boolean | undefined }> }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ host, 'x-forwarded-for': '203.0.113.7' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error('REDIRECT:' + p);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/staff-mfa-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/staff-mfa-store')>()),
  getStaffMfaStore: () => ({
    isEnrolled: async (u: string) => staffMfa.enrolled.has(u),
    verifyCode: async () => false,
  }),
  staffMfaEnrolled: async (u: string) => staffMfa.enrolled.has(u),
}));
vi.mock('@/lib/partner-step-up-gate', async (orig) => {
  const actual = await orig<typeof import('@/lib/partner-step-up-gate')>();
  return {
    ...actual,
    gateStaffStepUp: async (...a: Parameters<typeof actual.gateStaffStepUp>) => {
      gate.calls.push({ target: a[2], always: a[3]?.always });
      return gate.bypass ? null : actual.gateStaffStepUp(...a);
    },
  };
});

import { isStepUpRequired } from '@/lib/staff-step-up-result';
import { createSanctionsListRepo } from '@/db/repos/sanctions-list-repo';
import { hashEntries } from '@/lib/sanctions/ofac-sdn-loader';
import { parseInMhaCsv } from '@/lib/sanctions/in-mha-list';
import { t } from '@/lib/i18n';
import { confirmMhaListCurrentAction, uploadMhaListAction } from '@/app/admin-dashboard/compliance/sanctions-lists/actions';

const HEADER = 'id,type,name,aliases,weak_aliases,program,reference';
const NAME = (i: number) => `Invented Curated Org ${String.fromCharCode(65 + (i % 26))}${i}`;
const csvOf = (n: number, from = 0) =>
  [HEADER, ...Array.from({ length: n }, (_, k) => `m${from + k},Entity,${NAME(from + k)},Alias ${NAME(from + k)},,UAPA First Schedule,SO ${from + k}`)].join('\n');
const dayOffset = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const NEED_MFA = 'Turn on two-step verification for your own staff account first.';

function uploadForm(o: { csv?: string | null; file?: File | string; version?: string | null } = {}): FormData {
  const f = new FormData();
  if (o.file !== undefined) f.set('file', o.file);
  else if (o.csv !== null) f.set('file', new File([o.csv ?? csvOf(25)], 'mha.csv', { type: 'text/csv' }));
  if (o.version !== null) f.set('version', o.version ?? dayOffset(-1));
  return f;
}

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}
const versions = () =>
  rows<{ source: string; version: string; hash: string; active: boolean; entry_count: number; checked_at: string | Date }>(
    sql`SELECT source, version, hash, active, entry_count, checked_at FROM sanctions_list_versions ORDER BY id`,
  );
const audits = () =>
  rows<{ action: string; actor: string; actor_type: string; subject_id: string | null; partner_id: string | null; meta: Record<string, unknown> }>(
    sql`SELECT action, actor, actor_type, subject_id, partner_id, meta FROM audit_events WHERE action LIKE 'sanctions.list.%' ORDER BY id`,
  );
const snapshot = async () =>
  JSON.stringify({
    v: await versions(),
    e: await rows(sql`SELECT count(*)::int AS n FROM sanctions_list_entries`),
    a: await rows(sql`SELECT action, meta FROM audit_events WHERE action <> 'auth.stepup' ORDER BY id`),
  });

const platformAdmin = async (username = 'ops-admin'): Promise<Staff> => {
  staffMfa.enrolled.add(username);
  return signInAs(redis, cookieJar, { username, partnerId: undefined, role: 'admin' });
};
const BOTH = [
  ['upload', () => uploadMhaListAction(uploadForm())],
  ['confirm', () => confirmMhaListCurrentAction(new FormData())],
] as const;

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  host = 'smartremit.ai';
  staffMfa.enrolled = new Set();
  gate.bypass = true;
  gate.calls = [];
  db = await freshDb();
  await seedPartner(db, 'acme', 'Acme');
});

describe('MHA list actions: gates before any read', () => {
  it('a site host is refused (404) first, nothing written', async () => {
    await platformAdmin();
    host = 'acme.smartremit.ai';
    const before = await snapshot();
    for (const [, run] of BOTH) await expect(run()).rejects.toThrow('NOT_FOUND');
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
  });

  it('partner-scoped staff and non-admin platform staff are redirected, nothing written, no audit', async () => {
    const before = await snapshot();
    for (const o of [
      { username: 'acme-admin', role: 'admin' as const, partnerId: 'acme' },
      { username: 'ops-agent', role: 'agent' as const },
      { username: 'ops-support', role: 'support' as const },
    ]) {
      staffMfa.enrolled.add(o.username);
      await signInAs(redis, cookieJar, { partnerId: undefined, ...o });
      for (const [, run] of BOTH) await expect(run()).rejects.toThrow(/^REDIRECT:/);
    }
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
  });

  it('staff without MFA -> the NEED_MFA copy, nothing written, no audit (even for a bad file)', async () => {
    await signInAs(redis, cookieJar, { username: 'ops-admin', partnerId: undefined, role: 'admin' });
    const before = await snapshot();
    for (const [, run] of BOTH) expect(await run()).toEqual({ ok: false, error: NEED_MFA });
    expect(await uploadMhaListAction(uploadForm({ csv: 'nonsense' }))).toEqual({ ok: false, error: NEED_MFA });
    expect(await snapshot()).toBe(before);
    expect(gate.calls).toEqual([]);
  });
});

describe('uploadMhaListAction: bounds before the step-up', () => {
  const cases: Array<[string, () => FormData, string, RegExp]> = [
    ['no file', () => uploadForm({ csv: null }), 'no_file', /CSV file/],
    ['a text field instead of a file', () => uploadForm({ file: 'id,type' }), 'no_file', /CSV file/],
    ['an empty file', () => uploadForm({ csv: '' }), 'no_file', /CSV file/],
    ['file > 256 KB', () => uploadForm({ csv: csvOf(25) + '\n' + 'x'.repeat(256 * 1024) }), 'too_large', /256 KB/],
    ['fewer than 20 entries', () => uploadForm({ csv: csvOf(19) }), 'too_few_entries', /at least 20/],
    ['version missing', () => uploadForm({ version: null }), 'bad_version', /YYYY-MM-DD/],
    ['version not YYYY-MM-DD', () => uploadForm({ version: '2026-1-5' }), 'bad_version', /YYYY-MM-DD/],
    ['version not a calendar date', () => uploadForm({ version: '2026-02-30' }), 'bad_version', /YYYY-MM-DD/],
    ['version after today (UTC)', () => uploadForm({ version: dayOffset(2) }), 'bad_version', /not after today/],
  ];
  for (const [label, fd, code, copy] of cases) {
    it(`${label} -> refused naming the rule, no step-up, nothing stored, one 'refused' audit row`, async () => {
      await platformAdmin();
      const r = await uploadMhaListAction(fd());
      expect(r).toMatchObject({ ok: false });
      expect((r as { error: string }).error).toMatch(copy);
      expect(gate.calls).toEqual([]);
      expect(await versions()).toEqual([]);
      expect(await audits()).toEqual([
        {
          action: 'sanctions.list.upload',
          actor: 'ops-admin',
          actor_type: 'staff',
          subject_id: 'in-mha-uapa',
          partner_id: null,
          meta: { source: 'in-mha-uapa', errorCount: 1, codes: [code], outcome: 'refused' },
        },
      ]);
    });
  }

  it('more than 2,000 rows -> too_many_rows with its row number', async () => {
    await platformAdmin();
    const r = await uploadMhaListAction(uploadForm({ csv: csvOf(2001) }));
    expect(r).toMatchObject({ ok: false, rows: [{ row: 2002, code: 'too_many_rows' }] });
    expect((r as { error: string }).error).toMatch(/2,000/);
    expect(gate.calls).toEqual([]);
    expect(await versions()).toEqual([]);
    expect((await audits())[0].meta).toEqual({ source: 'in-mha-uapa', errorCount: 1, codes: ['too_many_rows'], outcome: 'refused' });
  });

  it('row errors -> row numbers and codes (never values); audit codes distinct and sorted, no name', async () => {
    await platformAdmin();
    const lines = csvOf(25).split('\n');
    lines[3] = 'm2,Ship,Zorvandel Quixotica,,,UAPA,SO';
    lines[5] = 'm4 x,Entity,Zorvandel Quixotica,Al|X,,UAPA,SO';
    lines[7] = 'm6,Ship,Invented Other Org,,,UAPA,SO';
    const r = await uploadMhaListAction(uploadForm({ csv: lines.join('\n') }));
    expect(r).toEqual({
      ok: false,
      error: expect.stringMatching(/rows listed/),
      rows: [
        { row: 4, code: 'bad_type' },
        { row: 6, code: 'bad_id' },
        { row: 6, code: 'name_too_short' },
        { row: 8, code: 'bad_type' },
      ],
    });
    expect(JSON.stringify(r)).not.toMatch(/Zorvandel|Quixotica/);
    expect(gate.calls).toEqual([]);
    expect(await versions()).toEqual([]);
    const a = await audits();
    expect(a.map((x) => x.meta)).toEqual([{ source: 'in-mha-uapa', errorCount: 4, codes: ['bad_id', 'bad_type', 'name_too_short'], outcome: 'refused' }]);
    expect(JSON.stringify(a)).not.toMatch(/Zorvandel|Quixotica|Invented/);
  });
});

describe('uploadMhaListAction: strict UTF-8 (pack 5 review LD1)', () => {
  // A Blob encodes a string part as UTF-8; a Uint8Array part goes in as raw bytes.
  const bytesFile = (parts: Array<string | Uint8Array<ArrayBuffer>>) => new File(parts, 'mha.csv', { type: 'text/csv' });
  const utf16le = (text: string) => {
    const out = new Uint8Array(2 + text.length * 2);
    out.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) {
      out[2 + i * 2] = text.charCodeAt(i) & 0xff;
      out[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    return new File([out], 'mha.csv', { type: 'text/csv' });
  };
  const cases: Array<[string, () => File]> = [
    [
      'a Windows-1252 byte (0xFC) in a name cell',
      () => {
        const lines = csvOf(25).split('\n');
        const [head, rest] = [lines.slice(0, 4).join('\n') + '\nm99,Entity,M', ',,,UAPA First Schedule,SO 99\n' + lines.slice(4).join('\n')];
        return bytesFile([head, new Uint8Array([0xfc]), 'ller Zorvandel', rest]);
      },
    ],
    ['a UTF-16LE file with a BOM', () => utf16le(csvOf(25))],
  ];
  for (const [label, file] of cases) {
    it(`${label} -> refused 'bad_encoding', no step-up, nothing stored, one 'refused' audit row without a name`, async () => {
      await platformAdmin();
      const r = await uploadMhaListAction(uploadForm({ file: file() }));
      expect(r).toEqual({ ok: false, error: expect.stringMatching(/UTF-8/) });
      expect(gate.calls).toEqual([]);
      expect(await versions()).toEqual([]);
      const a = await audits();
      expect(a.map((x) => x.meta)).toEqual([{ source: 'in-mha-uapa', errorCount: 1, codes: ['bad_encoding'], outcome: 'refused' }]);
      expect(JSON.stringify([a, r])).not.toMatch(/Zorvandel|Invented|ller/);
    });
  }

  it('a valid UTF-8 file with a BOM and diacritics still activates', async () => {
    await platformAdmin();
    const lines = csvOf(25).split('\n');
    lines[2] = 'm1,Individual,Zoë Müller-Ñandú,Invented Ålias Øre,,UAPA First Schedule,SO 1';
    const r = await uploadMhaListAction(uploadForm({ file: bytesFile(['\uFEFF' + lines.join('\n')]) }));
    expect(r).toMatchObject({ ok: true, outcome: 'activated' });
    const stored = await rows<{ names: string[] }>(sql`SELECT names FROM sanctions_list_entries WHERE entry_id = 'inmha:m1'`);
    expect(stored[0].names).toEqual(['Zoë Müller-Ñandú', 'Invented Ålias Øre']);
  });
});

describe('uploadMhaListAction: step-up and store', () => {
  // Review round 2 GF1: the expected versions (dayOffset) are read after each
  // upload; Date frozen (after the top-level freshDb()) so a run that crosses
  // UTC midnight reads the same day throughout.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it("step-up ALWAYS ('sanctions_list.upload', { always: true }); a StepUpRequired result is returned and nothing stored", async () => {
    await platformAdmin();
    gate.bypass = false;
    const before = await snapshot();
    const r = await uploadMhaListAction(uploadForm());
    expect(isStepUpRequired(r)).toBe(true);
    expect(gate.calls).toEqual([{ target: 'sanctions_list.upload', always: true }]);
    expect(await snapshot()).toBe(before);
  });

  it('valid upload -> activates the version; audit meta exactly { source, version, hash, entryCount, nameCount, outcome }', async () => {
    await platformAdmin();
    const version = dayOffset(-3);
    const csv = csvOf(25);
    const parsed = parseInMhaCsv(csv);
    if (!parsed.ok) throw new Error('fixture');
    expect(await uploadMhaListAction(uploadForm({ csv, version }))).toEqual({
      ok: true,
      outcome: 'activated',
      activeVersion: version,
      activeHash: parsed.list.hash,
    });
    const active = await createSanctionsListRepo(db).activeVersion('in-mha-uapa');
    expect(active).toMatchObject({ version, hash: hashEntries(parsed.list.entries), entryCount: 25 });
    expect(await audits()).toEqual([
      {
        action: 'sanctions.list.upload',
        actor: 'ops-admin',
        actor_type: 'staff',
        subject_id: 'in-mha-uapa',
        partner_id: null,
        meta: { source: 'in-mha-uapa', version, hash: parsed.list.hash, entryCount: 25, nameCount: 50, outcome: 'activated' },
      },
    ]);
    expect(gate.calls).toEqual([{ target: 'sanctions_list.upload', always: true }]);
  });

  it("the same content again -> outcome 'unchanged' and checked_at advances", async () => {
    await platformAdmin();
    await uploadMhaListAction(uploadForm());
    await db.execute(sql`UPDATE sanctions_list_versions SET checked_at = now() - interval '6 days'`);
    expect(await uploadMhaListAction(uploadForm())).toMatchObject({ ok: true, outcome: 'unchanged', activeVersion: dayOffset(-1) });
    const v = await versions();
    expect(v).toHaveLength(1);
    expect(Date.now() - new Date(v[0].checked_at).getTime()).toBeLessThan(60_000);
    expect((await audits()).map((a) => a.meta.outcome)).toEqual(['activated', 'unchanged']);
  });

  it("a list below 0.8 of the previous -> refused (shrink), active version unchanged, audit outcome 'shrink'", async () => {
    await platformAdmin();
    await uploadMhaListAction(uploadForm({ csv: csvOf(30), version: dayOffset(-5) }));
    const r = await uploadMhaListAction(uploadForm({ csv: csvOf(22, 100), version: dayOffset(-1) }));
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/80%/);
    expect(await createSanctionsListRepo(db).activeVersion('in-mha-uapa')).toMatchObject({ version: dayOffset(-5), entryCount: 30 });
    const active = (await createSanctionsListRepo(db).activeVersion('in-mha-uapa'))!;
    expect(r).toMatchObject({ activeVersion: dayOffset(-5), activeHash: active.hash });
    const last = (await audits()).at(-1)!;
    // Pack 5 review LD2: version and hash are the ACTIVE ones after the store; the typed date and
    // the uploaded hash follow as requestedVersion / requestedHash when they differ.
    const shrunk = parseInMhaCsv(csvOf(22, 100));
    if (!shrunk.ok) throw new Error('fixture');
    expect(last.meta).toEqual({
      source: 'in-mha-uapa',
      version: dayOffset(-5),
      hash: active.hash,
      entryCount: 22,
      nameCount: 44,
      outcome: 'shrink',
      requestedVersion: dayOffset(-1),
      requestedHash: shrunk.list.hash,
    });
  });

  it("an older version date -> refused (stale), outcome 'stale'", async () => {
    await platformAdmin();
    await uploadMhaListAction(uploadForm({ version: dayOffset(-1) }));
    const r = await uploadMhaListAction(uploadForm({ csv: csvOf(26), version: dayOffset(-4) }));
    expect(r).toMatchObject({ ok: false });
    // L1-LR1 (LF5-T1): the typed-date copy exactly, never the older-CONTENT copy.
    expect((r as { error: string }).error).toBe(t('admin.compliance.sanctionsLists.refused.stale'));
    expect((r as { error: string }).error).not.toBe(t('admin.compliance.sanctionsLists.refused.staleContent'));
    expect(await createSanctionsListRepo(db).activeVersion('in-mha-uapa')).toMatchObject({ version: dayOffset(-1), entryCount: 25 });
    expect((await audits()).at(-1)!.meta.outcome).toBe('stale');
  });

  it("pack 5 LD2: the same content under another date -> 'unchanged'; page and audit carry the STORED active version", async () => {
    await platformAdmin();
    const csv = csvOf(25);
    const parsed = parseInMhaCsv(csv);
    if (!parsed.ok) throw new Error('fixture');
    await uploadMhaListAction(uploadForm({ csv, version: dayOffset(-3) }));
    expect(await uploadMhaListAction(uploadForm({ csv, version: dayOffset(-1) }))).toEqual({
      ok: true,
      outcome: 'unchanged',
      activeVersion: dayOffset(-3),
      activeHash: parsed.list.hash,
    });
    expect((await audits()).at(-1)!.meta).toEqual({
      source: 'in-mha-uapa',
      version: dayOffset(-3),
      hash: parsed.list.hash,
      entryCount: 25,
      nameCount: 50,
      outcome: 'unchanged',
      requestedVersion: dayOffset(-1),
    });
  });

  it("pack 5 LD2: content equal to an OLDER stored version under a newer date -> 'stale'; the active version never moves back", async () => {
    await platformAdmin();
    const a = csvOf(25);
    const b = csvOf(26);
    const pa = parseInMhaCsv(a);
    const pb = parseInMhaCsv(b);
    if (!pa.ok || !pb.ok) throw new Error('fixture');
    await uploadMhaListAction(uploadForm({ csv: a, version: dayOffset(-5) }));
    await uploadMhaListAction(uploadForm({ csv: b, version: dayOffset(-3) }));
    const r = await uploadMhaListAction(uploadForm({ csv: a, version: dayOffset(-1) }));
    expect(r).toMatchObject({ ok: false, activeVersion: dayOffset(-3), activeHash: pb.list.hash });
    expect((r as { error: string }).error).toBe(t('admin.compliance.sanctionsLists.refused.staleContent'));
    expect(await createSanctionsListRepo(db).activeVersion('in-mha-uapa')).toMatchObject({ version: dayOffset(-3), hash: pb.list.hash, entryCount: 26 });
    expect((await audits()).at(-1)!.meta).toEqual({
      source: 'in-mha-uapa',
      version: dayOffset(-3),
      hash: pb.list.hash,
      entryCount: 25,
      nameCount: 50,
      outcome: 'stale',
      requestedVersion: dayOffset(-1),
      requestedHash: pa.list.hash,
    });
  });

  it('audit meta never holds a name (JSON scan over every outcome)', async () => {
    await platformAdmin();
    await uploadMhaListAction(uploadForm({ csv: csvOf(30), version: dayOffset(-5) }));
    await uploadMhaListAction(uploadForm({ csv: csvOf(30), version: dayOffset(-5) }));
    await uploadMhaListAction(uploadForm({ csv: csvOf(21, 200), version: dayOffset(-2) }));
    await uploadMhaListAction(uploadForm({ csv: csvOf(30, 300), version: dayOffset(-9) }));
    await uploadMhaListAction(uploadForm({ csv: csvOf(30).replace('Entity', 'Ship') }));
    const a = await audits();
    expect(a.map((x) => x.meta.outcome)).toEqual(['activated', 'unchanged', 'shrink', 'stale', 'refused']);
    expect(JSON.stringify(a)).not.toMatch(/Invented|Alias|UAPA First/);
  });
});

describe('confirmMhaListCurrentAction', () => {
  it('same gates: the step-up target is sanctions_list.upload, always; a StepUpRequired result writes nothing', async () => {
    await platformAdmin();
    await uploadMhaListAction(uploadForm());
    gate.bypass = false;
    gate.calls = [];
    const before = await snapshot();
    expect(isStepUpRequired(await confirmMhaListCurrentAction(new FormData()))).toBe(true);
    expect(gate.calls).toEqual([{ target: 'sanctions_list.upload', always: true }]);
    expect(await snapshot()).toBe(before);
  });

  it('with an active version -> checked_at advances only; audit sanctions.list.confirm { source, version, hash }', async () => {
    await platformAdmin();
    const version = dayOffset(-2);
    await uploadMhaListAction(uploadForm({ version }));
    await db.execute(sql`UPDATE sanctions_list_versions SET checked_at = now() - interval '7 days'`);
    const before = (await versions())[0];
    expect(await confirmMhaListCurrentAction(new FormData())).toEqual({ ok: true, outcome: 'confirmed' });
    const after = (await versions())[0];
    expect({ ...after, checked_at: null }).toEqual({ ...before, checked_at: null });
    expect(Date.now() - new Date(after.checked_at).getTime()).toBeLessThan(60_000);
    expect((await rows(sql`SELECT count(*)::int AS n FROM sanctions_list_entries`))[0]).toEqual({ n: 25 });
    expect((await audits()).at(-1)).toEqual({
      action: 'sanctions.list.confirm',
      actor: 'ops-admin',
      actor_type: 'staff',
      subject_id: 'in-mha-uapa',
      partner_id: null,
      meta: { source: 'in-mha-uapa', version, hash: before.hash },
    });
  });

  it("with no list -> 'No India MHA list is loaded.', no step-up, nothing written", async () => {
    await platformAdmin();
    const before = await snapshot();
    expect(await confirmMhaListCurrentAction(new FormData())).toEqual({ ok: false, error: 'No India MHA list is loaded.' });
    expect(gate.calls).toEqual([]);
    expect(await snapshot()).toBe(before);
  });
});
