import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCustomerRepo, recordEsignConsent, withdrawEsignConsent, type EsignConsentState } from '@/db/repos/customer-repo';
import type { Db, DbOrTx } from '@/db/client';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import { esignConsentNeeded, isCurrentEsignVersion, readEsignConsentNeeded } from '@/lib/esign';
import { freshDb } from './helpers-db';

// Fix pack 6 T2 (R46, P2 reader, P3 predicate). Relative dates only; the phone is an
// invented placeholder.

const PHONE = '15551230622';
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const state = (over: Partial<EsignConsentState>): EsignConsentState => ({
  version: ESIGN_CONSENT_VERSION,
  consentedAt: minutesAgo(10),
  withdrawnAt: null,
  ...over,
});

describe('esignConsentNeeded (pure)', () => {
  it('no row -> needed', () => {
    expect(esignConsentNeeded(null)).toBe(true);
  });

  it('version null, or a version that is not the current one -> needed', () => {
    expect(esignConsentNeeded(state({ version: null }))).toBe(true);
    expect(esignConsentNeeded(state({ version: 'esign-older' }))).toBe(true);
  });

  it('current version, consentedAt null -> needed', () => {
    expect(esignConsentNeeded(state({ consentedAt: null }))).toBe(true);
  });

  it('current version and consentedAt set, withdrawnAt null -> not needed', () => {
    expect(esignConsentNeeded(state({}))).toBe(false);
  });

  it('withdrawnAt equal to or after consentedAt -> needed; withdrawnAt before consentedAt (a re-consent) -> not needed', () => {
    const at = minutesAgo(10);
    expect(esignConsentNeeded(state({ consentedAt: at, withdrawnAt: new Date(at.getTime()) }))).toBe(true);
    expect(esignConsentNeeded(state({ consentedAt: at, withdrawnAt: minutesAgo(5) }))).toBe(true);
    expect(esignConsentNeeded(state({ consentedAt: at, withdrawnAt: minutesAgo(20) }))).toBe(false);
  });

  it('the current argument defaults to ESIGN_CONSENT_VERSION; an explicit other current makes the stored current version stale', () => {
    const s = state({});
    expect(esignConsentNeeded(s, ESIGN_CONSENT_VERSION)).toBe(false);
    expect(esignConsentNeeded(s, 'esign-next-draft')).toBe(true);
    expect(esignConsentNeeded(state({ version: 'esign-next-draft' }), 'esign-next-draft')).toBe(false);
  });
});

describe('isCurrentEsignVersion', () => {
  it('true only for ESIGN_CONSENT_VERSION', () => {
    expect(isCurrentEsignVersion(ESIGN_CONSENT_VERSION)).toBe(true);
    for (const v of ['', ` ${ESIGN_CONSENT_VERSION}`, `${ESIGN_CONSENT_VERSION} `, 'esign-older', null, undefined, 1, {}, [ESIGN_CONSENT_VERSION]]) {
      expect(isCurrentEsignVersion(v)).toBe(false);
    }
  });
});

describe('readEsignConsentNeeded (PGlite)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no row -> true; consent on file -> false; withdrawn -> true', async () => {
    expect(await readEsignConsentNeeded(db, 'default', PHONE)).toBe(true);
    await createCustomerRepo(db, async () => null).ensureCustomer('default', PHONE);
    expect(await readEsignConsentNeeded(db, 'default', PHONE)).toBe(true);
    expect(await recordEsignConsent(db, 'default', PHONE, ESIGN_CONSENT_VERSION, minutesAgo(5))).toBe(true);
    expect(await readEsignConsentNeeded(db, 'default', PHONE)).toBe(false);
    expect(await withdrawEsignConsent(db, 'default', PHONE, minutesAgo(1))).toBe(ESIGN_CONSENT_VERSION);
    expect(await readEsignConsentNeeded(db, 'default', PHONE)).toBe(true);
  });

  it('an older version on file -> true', async () => {
    await createCustomerRepo(db, async () => null).ensureCustomer('default', PHONE);
    await recordEsignConsent(db, 'default', PHONE, 'esign-older', minutesAgo(5));
    expect(await readEsignConsentNeeded(db, 'default', PHONE)).toBe(true);
  });

  it('a read error -> true, never throws, ONE pay.esign-read warning with the error name and partnerId only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    class SecretDbError extends Error {
      override name = 'SecretDbError';
    }
    const broken = {
      select: () => {
        throw new SecretDbError('connection to postgres://user:pw@host failed for 15551230622');
      },
    } as unknown as DbOrTx;
    await expect(readEsignConsentNeeded(broken, 'default', PHONE)).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.scope).toBe('pay.esign-read');
    expect(parsed.partnerId).toBe('default');
    expect(line).toContain('SecretDbError');
    expect(line).not.toContain(PHONE);
    expect(line).not.toContain('postgres://');
    expect(line).not.toContain('connection to');
  });
});
