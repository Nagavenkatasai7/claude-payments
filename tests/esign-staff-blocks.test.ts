import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Db } from '@/db/client';
import { freshDb } from './helpers-db';
import { seedEsignConsentForTest } from './helpers-esign';

// Fix pack 6 truth check TC-T1: the staff "Electronic records" blocks of the partner and admin
// customer pages (none / on file with the form / withdrawn / read failed), and their loaders (a
// failed read logs the error NAME only and never throws).
let db: Db;
const fault = { read: false };
const warns: unknown[][] = [];

vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  return {
    ...real,
    readEsignConsent: (...a: Parameters<typeof real.readEsignConsent>) => {
      if (fault.read) throw new TypeError('db down 15551231011');
      return real.readEsignConsent(...a);
    },
  };
});
vi.mock('@/lib/log', async (orig) => ({
  ...(await orig<typeof import('@/lib/log')>()),
  logWarn: (...a: unknown[]) => void warns.push(a),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { EsignConsentBlock, loadEsignConsentView as loadPartner } from '@/app/partner/(app)/customers/[ref]/esign-block';
import { EsignConsentCard, loadEsignConsentView as loadAdmin } from '@/app/admin-dashboard/customers/[ref]/esign-card';
import { ESIGN_CONSENT_VERSION } from '@/lib/legal/esign-consent';
import { t } from '@/lib/i18n';

const PHONE = '15551231011';
const partnerHtml = async () =>
  renderToStaticMarkup(createElement(EsignConsentBlock, { view: await loadPartner('default', PHONE), customerRef: 'ref-x' }));
const adminHtml = async (canWithdraw = true) =>
  renderToStaticMarkup(
    createElement(EsignConsentCard, { view: await loadAdmin('default', PHONE), partnerId: 'default', phone: PHONE, canWithdraw }),
  );

beforeEach(async () => {
  db = await freshDb();
  fault.read = false;
  warns.length = 0;
});

describe('partner Electronic records block (TC-T1)', () => {
  it('none: the line, no form', async () => {
    const html = await partnerHtml();
    expect(html).toContain(t('partner.customers.esign.title'));
    expect(html).toContain(t('partner.customers.esign.sub'));
    expect(html).toContain(t('partner.customers.esign.none'));
    expect(html).not.toContain('name="confirm"');
  });
  it('on file: version, the tick and the button carrying the opaque ref only', async () => {
    await seedEsignConsentForTest(db, 'default', PHONE);
    const html = await partnerHtml();
    expect(html).toContain(ESIGN_CONSENT_VERSION);
    expect(html).toContain('name="confirm"');
    expect(html).toContain(t('partner.customers.esign.confirm'));
    expect(html).toContain(t('partner.customers.esign.submit'));
    expect(html).toContain('value="ref-x"');
    expect(html).not.toContain(PHONE);
  });
  it('withdrawn: the date line, no form', async () => {
    await seedEsignConsentForTest(db, 'default', PHONE, { withdrawn: true });
    const html = await partnerHtml();
    expect(html).toContain('Consent withdrawn ');
    expect(html).not.toContain('name="confirm"');
  });
  it('a failed read: "Not available right now.", the error NAME logged only', async () => {
    fault.read = true;
    const html = await partnerHtml();
    expect(html).toContain(t('partner.customers.esign.unavailable'));
    expect(warns).toEqual([['partner.customers.esign-read', 'TypeError', { partnerId: 'default' }]]);
    expect(JSON.stringify(warns)).not.toContain(PHONE);
  });
});

describe('admin Electronic records card (TC-T1)', () => {
  it('on file: the form for an admin, none for a non-admin', async () => {
    await seedEsignConsentForTest(db, 'default', PHONE);
    const html = await adminHtml(true);
    expect(html).toContain('Electronic records');
    expect(html).toContain('The next pay-page payment asks the customer again.');
    expect(html).toContain('The customer asked to withdraw this consent.');
    expect(html).toContain('Record withdrawal');
    expect(await adminHtml(false)).not.toContain('Record withdrawal');
  });
  it('none and withdrawn: no form', async () => {
    expect(await adminHtml()).toContain('No consent on file.');
    await seedEsignConsentForTest(db, 'default', PHONE, { withdrawn: true });
    const html = await adminHtml();
    expect(html).toContain('Consent withdrawn ');
    expect(html).not.toContain('Record withdrawal');
  });
  it('a failed read: "Not available right now.", the error NAME logged only', async () => {
    fault.read = true;
    expect(await adminHtml()).toContain('Not available right now.');
    expect(warns).toEqual([['admin.customers.esign-read', 'TypeError', { partnerId: 'default' }]]);
  });
});
