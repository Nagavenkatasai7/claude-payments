import { describe, it, expect, beforeEach } from 'vitest';
import { readEsignConsent } from '@/db/repos/customer-repo';
import type { Db } from '@/db/client';
import { esignConsentNeeded } from '@/lib/esign';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import { freshDb, seedPartner } from './helpers-db';
import { seedEsignConsentForTest } from './helpers-esign';

// Fix pack 6 T4 (P24): the ONE consent fixture of the pay-route tests. Phones are
// invented placeholders.

const PHONE = '15551230655';

describe('seedEsignConsentForTest (pack 6 P24)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'acme');
  });

  it('creates the customers row when absent and records the current version', async () => {
    expect(await readEsignConsent(db, 'acme', PHONE)).toBeNull();
    await seedEsignConsentForTest(db, 'acme', PHONE);
    const s = await readEsignConsent(db, 'acme', PHONE);
    expect(s?.version).toBe(ESIGN_CONSENT_VERSION);
    expect(s?.consentedAt).toBeInstanceOf(Date);
    expect(s?.consentedAt!.getTime()).toBeLessThan(Date.now());
    expect(s?.withdrawnAt).toBeNull();
    expect(esignConsentNeeded(s)).toBe(false);
    // tenant scope: the default tenant has no row for that phone
    expect(await readEsignConsent(db, 'default', PHONE)).toBeNull();
  });

  it('{ version } overrides the version', async () => {
    await seedEsignConsentForTest(db, 'acme', PHONE, { version: 'esign-old-v0' });
    const s = await readEsignConsent(db, 'acme', PHONE);
    expect(s?.version).toBe('esign-old-v0');
    expect(esignConsentNeeded(s)).toBe(true);
  });

  it('{ withdrawn: true } leaves a withdrawn consent (esignConsentNeeded true)', async () => {
    await seedEsignConsentForTest(db, 'acme', PHONE, { withdrawn: true });
    const s = await readEsignConsent(db, 'acme', PHONE);
    expect(s?.version).toBe(ESIGN_CONSENT_VERSION);
    expect(s?.withdrawnAt).toBeInstanceOf(Date);
    expect(esignConsentNeeded(s)).toBe(true);
  });

  it('a second call is idempotent', async () => {
    await seedEsignConsentForTest(db, 'acme', PHONE);
    await seedEsignConsentForTest(db, 'acme', PHONE);
    const s = await readEsignConsent(db, 'acme', PHONE);
    expect(s?.version).toBe(ESIGN_CONSENT_VERSION);
    expect(esignConsentNeeded(s)).toBe(false);
  });
});
