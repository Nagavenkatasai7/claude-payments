import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { certifiedLiveControls } from './helpers-live';
import {
  PARTNER_EVENT_TYPES,
  isPartnerEventType,
  partnerEventsApply,
  partnerEventDedupeKey,
  partnerEventTarget,
  buildPartnerEventBody,
  type PartnerEventInput,
} from '@/lib/partner-events';
import type { ScopeOwner } from '@/lib/partner-decision-scope';
import type { ScreeningView } from '@/lib/partner-screening-view';
import type { PartnerIntegrations } from '@/lib/partner-integrations';
import { signRailHeaders, verifyRailSignature } from '@/lib/providers/rail-signature';

// Fix pack 7 T19 (P16): the pure core of compliance events to a live-certified
// partner. No DB, no network.

function owner(o: Partial<ScopeOwner> = {}): ScopeOwner {
  return { id: 'acme', status: 'active', kycMode: 'ours', liveControls: certifiedLiveControls(), ...o };
}

function screening(o: Partial<ScreeningView> = {}): ScreeningView {
  return {
    listSource: 'ofac-sdn',
    listVersion: 'v-2026-test',
    screenedAt: new Date(Date.now() - 60_000).toISOString(),
    decision: 'possible_match',
    parties: [
      { role: 'sender', matched: true, score: 0.93, matchedEntryId: 'sdn-123', screened: true },
      { role: 'recipient', matched: false, score: null, matchedEntryId: null, screened: false },
    ],
    ...o,
  };
}

function matchInput(o: Partial<Extract<PartnerEventInput, { type: 'screening.potential_match' }>> = {}): PartnerEventInput {
  return {
    type: 'screening.potential_match',
    eventId: 'evt_1',
    created: Math.floor(Date.now() / 1000),
    ownerId: 'acme',
    transferId: 'tr_1',
    clientReference: 'ORD-9',
    screening: screening(),
    ...o,
  };
}

function dispositionInput(): PartnerEventInput {
  return {
    type: 'hold.disposition',
    eventId: 'evt_2',
    created: Math.floor(Date.now() / 1000),
    ownerId: 'acme',
    transferId: 'tr_2',
    clientReference: null,
    review: {
      holdClass: 'sanctions_review',
      step: 1,
      final: true,
      disposition: 'false_positive_match',
      actorScope: 'partner',
      createdAt: new Date(Date.now() - 5_000).toISOString(),
    },
  };
}

const sortedKeys = (o: object) => Object.keys(o).sort();

function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  }
  return out;
}

describe('partner-events (P16)', () => {
  it('PARTNER_EVENT_TYPES is the frozen closed tuple; isPartnerEventType', () => {
    expect([...PARTNER_EVENT_TYPES]).toEqual(['screening.potential_match', 'hold.disposition']);
    expect(Object.isFrozen(PARTNER_EVENT_TYPES)).toBe(true);
    expect(isPartnerEventType('screening.potential_match')).toBe(true);
    expect(isPartnerEventType('hold.disposition')).toBe(true);
    for (const v of ['reply', '__proto__', 'toString', 'constructor', 1, null, undefined, {}]) {
      expect(isPartnerEventType(v)).toBe(false);
    }
  });

  it('partnerEventsApply: certified active owner and a live row only', () => {
    const live = { environment: 'live' as const };
    expect(partnerEventsApply(owner(), live)).toBe(true);
    expect(partnerEventsApply(owner(), {})).toBe(true);
    expect(partnerEventsApply(owner(), { environment: 'test' })).toBe(false);
    expect(partnerEventsApply(owner({ liveControls: undefined }), live)).toBe(false);
    expect(partnerEventsApply(owner({ status: 'suspended' }), live)).toBe(false);
    const lc = certifiedLiveControls();
    const revoked = { ...lc, certification: { ...lc.certification!, revokedAt: lc.certification!.certifiedAt } };
    expect(partnerEventsApply(owner({ liveControls: revoked }), live)).toBe(false);
    expect(partnerEventsApply(owner({ id: 'default' }), live)).toBe(false);
    expect(partnerEventsApply(null, live)).toBe(false);
    expect(partnerEventsApply(undefined, live)).toBe(false);
  });

  it('partnerEventDedupeKey: `${type}:${subject}`, never reply:, refuses an empty or colon subject', () => {
    expect(partnerEventDedupeKey('screening.potential_match', 'tr_1')).toBe('screening.potential_match:tr_1');
    expect(partnerEventDedupeKey('hold.disposition', 'rev_9')).toBe('hold.disposition:rev_9');
    for (const t of PARTNER_EVENT_TYPES) expect(partnerEventDedupeKey(t, 'x').startsWith('reply:')).toBe(false);
    expect(() => partnerEventDedupeKey('hold.disposition', '')).toThrow();
    expect(() => partnerEventDedupeKey('hold.disposition', 'a:b')).toThrow();
  });

  it('partnerEventTarget: http rail only; eventsUrl, then settlementUrl; blank is absent; never a hosted fallback', () => {
    const p = (providerType: string | undefined, credentials?: Record<string, string>): PartnerIntegrations['payment'] => ({
      providerType,
      credentials,
    });
    expect(partnerEventTarget(p('http', { eventsUrl: 'https://e.example/ev', settlementUrl: 'https://e.example/s' }))).toBe('https://e.example/ev');
    expect(partnerEventTarget(p('http', { settlementUrl: 'https://e.example/s' }))).toBe('https://e.example/s');
    expect(partnerEventTarget(p('http', { eventsUrl: '', settlementUrl: 'https://e.example/s' }))).toBe('https://e.example/s');
    expect(partnerEventTarget(p('http', {}))).toBeNull();
    expect(partnerEventTarget(p('http'))).toBeNull();
    for (const t of ['mock', undefined, 'simulator']) {
      expect(partnerEventTarget(p(t, { eventsUrl: 'https://e.example/ev', settlementUrl: 'https://e.example/s' }))).toBeNull();
    }
    expect(partnerEventTarget(undefined as unknown as PartnerIntegrations['payment'])).toBeNull();
  });

  it('potential match body: exact keys at every level; unscreened parties left out; no client reference -> null', () => {
    const i = matchInput();
    const body = buildPartnerEventBody(i);
    expect(sortedKeys(body)).toEqual(['created', 'data', 'id', 'partner_id', 'type']);
    expect(body).toMatchObject({ type: 'screening.potential_match', id: 'evt_1', created: i.created, partner_id: 'acme' });
    const data = body.data as unknown as Record<string, unknown>;
    expect(sortedKeys(data)).toEqual(
      ['client_reference', 'decision', 'list_source', 'list_version', 'parties', 'screened_at', 'transfer_id'].sort(),
    );
    expect(data).toMatchObject({
      transfer_id: 'tr_1',
      client_reference: 'ORD-9',
      list_source: 'ofac-sdn',
      list_version: 'v-2026-test',
      decision: 'possible_match',
      screened_at: (i as Extract<PartnerEventInput, { type: 'screening.potential_match' }>).screening.screenedAt,
    });
    expect(data.parties).toEqual([{ role: 'sender', matched: true, score: 0.93, matched_entry_id: 'sdn-123' }]);
    for (const party of data.parties as object[]) {
      expect(sortedKeys(party)).toEqual(['matched', 'matched_entry_id', 'role', 'score']);
    }
    const noRef = buildPartnerEventBody(matchInput({ clientReference: null }));
    expect((noRef.data as unknown as Record<string, unknown>).client_reference).toBeNull();
  });

  it('disposition body: exact keys; decided_at = review.createdAt; actor_scope copied', () => {
    const i = dispositionInput() as Extract<PartnerEventInput, { type: 'hold.disposition' }>;
    const body = buildPartnerEventBody(i);
    expect(sortedKeys(body)).toEqual(['created', 'data', 'id', 'partner_id', 'type']);
    expect(body).toMatchObject({ type: 'hold.disposition', id: 'evt_2', created: i.created, partner_id: 'acme' });
    expect(body.data).toEqual({
      transfer_id: 'tr_2',
      client_reference: null,
      hold_class: 'sanctions_review',
      step: 1,
      final: true,
      disposition: 'false_positive_match',
      actor_scope: 'partner',
      decided_at: i.review.createdAt,
    });
    const platform = buildPartnerEventBody({ ...i, review: { ...i.review, actorScope: 'platform', step: 2 } });
    expect(platform.data).toMatchObject({ actor_scope: 'platform', step: 2 });
  });

  it('no PII or hash reaches the body, even when a caller object carries extra fields', () => {
    const planted = {
      inputHash: 'PLANTED-HASH-1', listHash: 'PLANTED-HASH-2', name: 'PLANTED-NAME', phone: '+15550001111',
      amount: 987654, reference: 'PLANTED-REF', payout: 'PLANTED-PAYOUT', reason: 'PLANTED-REASON',
    };
    const banned = Object.keys(planted);
    const base = matchInput() as Extract<PartnerEventInput, { type: 'screening.potential_match' }>;
    const dirtyMatch = {
      ...base,
      ...planted,
      screening: {
        ...base.screening,
        ...planted,
        parties: base.screening.parties.map((p) => ({ ...p, ...planted })),
      },
    } as unknown as PartnerEventInput;
    const d = dispositionInput() as Extract<PartnerEventInput, { type: 'hold.disposition' }>;
    const dirtyDisp = { ...d, ...planted, review: { ...d.review, ...planted } } as unknown as PartnerEventInput;
    for (const input of [dirtyMatch, dirtyDisp]) {
      const body = buildPartnerEventBody(input);
      const keys = allKeys(body);
      for (const k of [...banned, 'screened']) expect(keys).not.toContain(k);
      const raw = JSON.stringify(body);
      for (const v of Object.values(planted)) expect(raw).not.toContain(String(v));
    }
  });

  it('a screening that is not possible_match throws; an unknown type throws', () => {
    for (const decision of ['clear', 'match', 'list_unavailable'] as const) {
      expect(() => buildPartnerEventBody(matchInput({ screening: screening({ decision: decision as ScreeningView['decision'] }) }))).toThrow();
    }
    expect(() => buildPartnerEventBody({ ...dispositionInput(), type: 'reply' } as unknown as PartnerEventInput)).toThrow(
      'unknown partner event',
    );
  });

  it('signs and verifies with the existing rail signer', () => {
    const now = Date.now();
    const raw = JSON.stringify(buildPartnerEventBody(matchInput()));
    const secrets = ['s3cret-for-test'];
    const r = verifyRailSignature(raw, new Headers(signRailHeaders(raw, secrets, now)), secrets, now, { route: 'test' });
    expect(r.ok).toBe(true);
  });

  // T21 (P16): enqueuePartnerEvent lives here (the contract), so the outbox repo is the one
  // db import; still no node built-in, no env, and exactly these two runtime imports.
  it('the module stays server-light: no node or env import; runtime imports the outbox repo and partner-decision-scope only', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'partner-events.ts'), 'utf8');
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms)].map((m) => ({
      typeOnly: !!m[1],
      from: m[2],
    }));
    expect(imports.length).toBeGreaterThan(0);
    for (const im of imports) {
      // A db import is the outbox repo (runtime) or the DbOrTx type, nothing else.
      if (im.from.startsWith('@/db')) expect(im.typeOnly ? im.from === '@/db/client' : im.from === '@/db/repos/outbox-repo').toBe(true);
      expect(im.from.startsWith('node:')).toBe(false);
      expect(im.from).not.toMatch(/(^|\/)env$/);
    }
    expect(imports.filter((im) => !im.typeOnly).map((im) => im.from)).toEqual(['@/db/repos/outbox-repo', './partner-decision-scope']);
  });
});
