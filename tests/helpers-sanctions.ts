import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOfacSdnXml } from '@/lib/sanctions/ofac-sdn-loader';
import { PostgresSanctionsListSource } from '@/lib/sanctions/pg-list-source';
import { setListSourceForTests, setOfacListSourceForTests } from '@/lib/providers/sanctions-provider';
import { SANCTIONS_SOURCES, type SanctionsSourceId } from '@/lib/sanctions/list-sets';
import { createHash } from 'node:crypto';
import type { ActiveSanctionsVersion } from '@/db/repos/sanctions-list-repo';
import type { SanctionsList, SanctionsListSource } from '@/lib/sanctions/list-source';
import { inputHash, sanctionsAuditEvent, type ScreeningEvidence } from '@/lib/sanctions/evidence';
import type { ListFitness } from '@/lib/sanctions/list-policy';
import { sql } from 'drizzle-orm';
import { auditEvents } from '@/db/schema';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';

// Program-Fix 14 PR C: an OFAC source whose cache holds v1 while v2 (with
// newly listed names) is the ACTIVE version — only a warmSanctionsList() call
// before the screen can pick v2 up. ttlMs 0 ⇒ every warm() re-checks.
export const NEWLY_LISTED_PERSON = 'Newly Listed Person';
export const NEWLY_LISTED_BUSINESS = 'Newly Listed Trading LLC';

export async function primeStaleOfacSource(): Promise<void> {
  const v1: SanctionsList = parseOfacSdnXml(
    readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8'),
  );
  const v2: SanctionsList = {
    ...v1,
    version: '2026-09-22',
    hash: 'c'.repeat(64),
    entries: [
      ...v1.entries,
      { id: 'sdn:2001', names: [NEWLY_LISTED_PERSON], type: 'Individual', programs: ['SDGT'] },
      { id: 'sdn:2002', names: [NEWLY_LISTED_BUSINESS], type: 'Entity', programs: ['SDGT'] },
    ],
  };
  const V1: ActiveSanctionsVersion = { id: 1, source: 'ofac-sdn', version: v1.version, hash: v1.hash, entryCount: v1.entries.length };
  const V2: ActiveSanctionsVersion = { id: 2, source: 'ofac-sdn', version: v2.version, hash: v2.hash, entryCount: v2.entries.length };
  const state = { active: V1 };
  const src = new PostgresSanctionsListSource(
    () => ({ activeVersion: async () => state.active, loadList: async (v) => (v.id === 1 ? v1 : v2) }),
    { ttlMs: 0 },
  );
  await src.load(); // v1 cached
  state.active = V2; // v2 activated after the TTL
  process.env.SANCTIONS_LIST = 'ofac-sdn';
  setOfacListSourceForTests(src);
}

/** The OFAC SDN sample fixture (5 entries; 'Testa Fixturelli' is sdn:1003). */
export function ofacSampleList(): SanctionsList {
  return parseOfacSdnXml(readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8'));
}

/**
 * Fix pack 2 T2 (R02): select a fresh in-memory `ofac-sdn` source (the sample
 * fixture) whose checkedAt() is `checkedAgoMs` before the current time on every
 * call, and SANCTIONS_LIST=ofac-sdn. 3_600_000 = a live list; anything over
 * 36 h = stale. Undo with restoreOfacSource(original).
 */
export function primeOfacSource(opts: { checkedAgoMs: number }): SanctionsListSource {
  const list = ofacSampleList();
  const src: SanctionsListSource = {
    load: async () => list,
    warm: async () => {},
    checkedAt: () => new Date(Date.now() - opts.checkedAgoMs),
  };
  process.env.SANCTIONS_LIST = 'ofac-sdn';
  setOfacListSourceForTests(src);
  return src;
}

/**
 * Fix pack 2 T9 (R02): write one `sanctions.screen` evidence row for a stored
 * transfer, as the mint would: OWNER tenant, the transfer id as subject, the
 * real keyed `inputHash` of each name. Defaults to a LIVE list screened now, so
 * a cleared transfer on an http rail settles (settleOrHold's backstop).
 * `listFitness: null` omits the field (pre-pack-2 evidence); `at` sets the
 * audit row's own time (default now).
 */
export async function seedLiveEvidence(
  db: Db,
  t: Pick<Transfer, 'id' | 'partnerId' | 'recipientName'> & { senderName?: string; alsoRecipientNames?: string[] },
  opts: { listFitness?: ListFitness | null; screenedAgoMs?: number; at?: Date; decision?: ScreeningEvidence['decision'] } = {},
): Promise<ScreeningEvidence> {
  const parties: ScreeningEvidence['parties'] = [
    { role: 'recipient', inputHash: inputHash(t.recipientName), matched: false, matchScore: 0 },
    ...(t.alsoRecipientNames ?? []).map((n) => ({ role: 'recipient' as const, inputHash: inputHash(n), matched: false, matchScore: 0 })),
  ];
  if (t.senderName !== undefined) {
    parties.push({ role: 'sender', inputHash: inputHash(t.senderName), matched: false, matchScore: 0 });
  }
  const fitness = opts.listFitness === undefined ? 'live' : opts.listFitness;
  const evidence: ScreeningEvidence = {
    listSource: 'ofac-sdn',
    listVersion: 'test-version',
    listHash: 'a'.repeat(64),
    screenedAt: new Date(Date.now() - (opts.screenedAgoMs ?? 0)).toISOString(),
    decision: opts.decision ?? 'clear',
    parties,
    ...(fitness ? { listFitness: fitness } : {}),
  };
  const row = sanctionsAuditEvent(t.partnerId, t.id, evidence);
  await db.insert(auditEvents).values({
    partnerId: row.partnerId ?? null,
    actor: row.actor,
    actorType: row.actorType,
    action: row.action,
    subjectId: row.subjectId ?? null,
    meta: row.meta ?? null,
    ...(opts.at ? { at: opts.at } : {}),
  });
  return evidence;
}

export function restoreOfacSource(original: string | undefined): void {
  if (original === undefined) delete process.env.SANCTIONS_LIST;
  else process.env.SANCTIONS_LIST = original;
  setOfacListSourceForTests(null);
  // Fix pack 5 T28: every list source of the 'lists' mode back to its Postgres default.
  for (const s of SANCTIONS_SOURCES) setListSourceForTests(s, null);
}

/**
 * Fix pack 5 T28 (R08): one invented listed name per source. ofac-sdn is the
 * SDN sample fixture ('Testa Fixturelli' is sdn:1003); the others are
 * hand-built one-entry lists with ids cons:1, unsc:1, inmha:1.
 */
export const LIST_SET_NAMES: Readonly<Record<SanctionsSourceId, string>> = Object.freeze({
  'ofac-sdn': 'Testa Fixturelli',
  'ofac-cons': 'Consolida Inventedname',
  'un-sc': 'Unsc Inventedperson',
  'in-mha-uapa': 'Mha Inventedgroup',
});

const LIST_SET_PREFIX: Readonly<Record<SanctionsSourceId, string>> = Object.freeze({
  'ofac-sdn': 'sdn', 'ofac-cons': 'cons', 'un-sc': 'unsc', 'in-mha-uapa': 'inmha',
});

/** An invented one-entry list for a source (the SDN sample for ofac-sdn). */
export function listSetList(source: SanctionsSourceId): SanctionsList {
  if (source === 'ofac-sdn') return ofacSampleList();
  const name = LIST_SET_NAMES[source];
  return {
    source,
    version: '2026-10-01',
    hash: createHash('sha256').update(`${source}:${name}`, 'utf8').digest('hex'),
    entries: [{ id: `${LIST_SET_PREFIX[source]}:1`, names: [name], type: 'Individual', programs: ['TEST'] }],
  };
}

/**
 * Fix pack 5 T28 (R08): SANCTIONS_LIST=lists over four in-memory sources.
 * `checkedAgoMs[source]` (default 1 h = live) sets each checkedAt relative to
 * now on every call; a `missing` source's load rejects (no active version).
 * Undo with restoreOfacSource(original).
 */
export function primeListSet(opts: {
  checkedAgoMs?: Partial<Record<SanctionsSourceId, number>>;
  missing?: SanctionsSourceId[];
}): Record<SanctionsSourceId, SanctionsListSource> {
  const out = {} as Record<SanctionsSourceId, SanctionsListSource>;
  for (const source of SANCTIONS_SOURCES) {
    const list = listSetList(source);
    const missing = (opts.missing ?? []).includes(source);
    const ago = opts.checkedAgoMs?.[source] ?? 3_600_000;
    const src: SanctionsListSource = {
      load: async () => {
        if (missing) throw new Error(`no active ${source} list version is loaded`);
        return list;
      },
      warm: async () => {},
      checkedAt: () => (missing ? null : new Date(Date.now() - ago)),
    };
    setListSourceForTests(source, src);
    out[source] = src;
  }
  process.env.SANCTIONS_LIST = 'lists';
  return out;
}

/**
 * Fix pack 2 T3 (R02): set a partner's rail type in partner_integrations (the
 * row live-gate.ts readRailProviderType reads). 'http' makes the partner's
 * transfers and payees real money.
 */
export async function setRailProviderType(db: Db, partnerId: string, providerType: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO partner_integrations (partner_id, payment_provider_type) VALUES (${partnerId}, ${providerType})
    ON CONFLICT (partner_id) DO UPDATE SET payment_provider_type = ${providerType}`);
}
