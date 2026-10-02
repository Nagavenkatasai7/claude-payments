import { describe, it, expect, beforeEach } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { auditEvents, partners } from '@/db/schema';
import { createPartnerStore } from '@/lib/partner-store';
import {
  DISCLOSURE_TEXT_MAX,
  parseAlertEmail,
  parseDisclosureForm,
  parseSupportPortal,
  setAlertEmail,
  setDisclosure,
  setSupportKnobs,
  setSupportPortal,
} from '@/lib/partner-support-settings';
import { MAX_DELIVERY_BUSINESS_DAYS } from '@/lib/partner-config';

// partner-support-settings: the support-portal switch, the channel alert email and the Reg E
// disclosure, shared by the legacy "My partner" actions and /partner/settings. The parsers are pure
// and return a reason (the caller picks the copy); each writer merges ONLY its own keys into
// partners.support_config under the row lock and writes its audit row in the same transaction.

const DISCLOSURE = {
  licensedEntity: 'Acme Money Services LLC',
  licenseIds: ['NMLS 000000'],
  phone: '+1 800 555 0100',
  website: 'https://acme.example',
  stateRegulator: { name: 'State Department of Financial Services', phone: '+1 800 555 0199', website: 'https://regulator.example' },
  deliveryEstimate: { businessDays: 2 },
};

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const fullForm = (over: Record<string, string> = {}) =>
  form({
    licensedEntity: 'Acme Money Services LLC',
    licenseIds: 'NMLS 000000',
    phone: '+1 800 555 0100',
    website: 'https://acme.example',
    regulatorName: 'State Department of Financial Services',
    regulatorPhone: '+1 800 555 0199',
    regulatorWebsite: 'https://regulator.example',
    deliveryBusinessDays: '2',
    ...over,
  });

describe('parseDisclosureForm (pure)', () => {
  it('a full form → the config', () => {
    expect(parseDisclosureForm(fullForm())).toEqual({ ok: true, value: DISCLOSURE });
  });
  it('an all-blank (or empty) form → undefined (clear)', () => {
    expect(parseDisclosureForm(new FormData())).toEqual({ ok: true, value: undefined });
    expect(parseDisclosureForm(fullForm({ licensedEntity: '', licenseIds: '', phone: '', website: '', regulatorName: '', regulatorPhone: '', regulatorWebsite: '', deliveryBusinessDays: '' }))).toEqual({ ok: true, value: undefined });
  });
  it('splits licence ids on commas and new lines, drops blanks, keeps at most 20', () => {
    const r = parseDisclosureForm(fullForm({ licenseIds: 'NMLS 1, CA DFPI 2\n\n TX 3 ' }));
    expect(r.ok && r.value?.licenseIds).toEqual(['NMLS 1', 'CA DFPI 2', 'TX 3']);
    const many = Array.from({ length: 25 }, (_, i) => `L${i}`).join(',');
    const r2 = parseDisclosureForm(fullForm({ licenseIds: many }));
    expect(r2.ok && r2.value?.licenseIds).toHaveLength(20);
  });
  it('blank optional fields are omitted, never stored as empty strings', () => {
    const r = parseDisclosureForm(fullForm({ licenseIds: '', regulatorName: '', regulatorPhone: '', regulatorWebsite: '', deliveryBusinessDays: '' }));
    expect(r).toEqual({ ok: true, value: { licensedEntity: 'Acme Money Services LLC', phone: '+1 800 555 0100', website: 'https://acme.example' } });
  });
  it('bounds partner-written text (no line breaks, clamped length)', () => {
    const r = parseDisclosureForm(fullForm({ licensedEntity: `Acme\nMoney ${'x'.repeat(300)}` }));
    const entity = (r.ok && r.value?.licensedEntity) || '';
    expect(entity).not.toContain('\n');
    expect([...entity].length).toBeLessThanOrEqual(DISCLOSURE_TEXT_MAX);
  });
  it.each([
    ['a non-https provider website', { website: 'http://acme.example' }, 'provider_website'],
    ['a javascript: provider website', { website: 'javascript:alert(1)' }, 'provider_website'],
    ['a malformed regulator website', { regulatorWebsite: 'not a url' }, 'regulator_website'],
    ['a provider phone with letters', { phone: 'call us' }, 'provider_phone'],
    ['a too-short provider phone', { phone: '12' }, 'provider_phone'],
    ['a bad regulator phone', { regulatorPhone: '555-CALL' }, 'regulator_phone'],
    ['a negative delivery estimate', { deliveryBusinessDays: '-1' }, 'delivery_days'],
    ['a fractional delivery estimate', { deliveryBusinessDays: '1.5' }, 'delivery_days'],
    ['a delivery estimate over the max', { deliveryBusinessDays: String(MAX_DELIVERY_BUSINESS_DAYS + 1) }, 'delivery_days'],
    ['a regulator phone without its name', { regulatorName: '' }, 'regulator_name_required'],
    ['details without the licensed entity', { licensedEntity: '' }, 'entity_required'],
  ] as const)('refuses %s with reason %s', (_label, over, reason) => {
    expect(parseDisclosureForm(fullForm(over))).toEqual({ ok: false, reason });
  });
  it('checks in the legacy order: the provider phone is reported before the provider website', () => {
    expect(parseDisclosureForm(fullForm({ phone: 'x', website: 'http://a.example' }))).toEqual({ ok: false, reason: 'provider_phone' });
  });
  it('a non-string field value (a File) is treated as blank text, never thrown on', () => {
    const fd = fullForm();
    fd.set('licensedEntity', new File(['x'], 'x.txt'));
    expect(parseDisclosureForm(fd)).toEqual({ ok: false, reason: 'entity_required' });
  });
});

describe('parseAlertEmail / parseSupportPortal (pure)', () => {
  it('a plain address → trimmed; blank → null (turn off); junk or a list → invalid', () => {
    expect(parseAlertEmail(' ops@acme.example ')).toEqual({ ok: true, value: 'ops@acme.example' });
    expect(parseAlertEmail('')).toEqual({ ok: true, value: null });
    expect(parseAlertEmail(null)).toEqual({ ok: true, value: null });
    for (const bad of ['not an email', 'a@b.example, c@d.example', 'a@b.example\r\nBcc: x@y.example'])
      expect(parseAlertEmail(bad)).toEqual({ ok: false, reason: 'invalid_email' });
    expect(parseAlertEmail(new File(['x'], 'x'))).toEqual({ ok: false, reason: 'invalid_email' });
  });
  it("the portal switch is on only for the exact checkbox value 'on'", () => {
    expect(parseSupportPortal('on')).toBe(true);
    for (const v of [null, '', 'true', 'ON', 'off']) expect(parseSupportPortal(v)).toBe(false);
  });
});

describe('the support_config writers (PGlite)', () => {
  let db: Db;
  const actor = { username: 'pa-admin', actorScope: 'partner' as const };
  const sc = async (id = 'pa') => (await createPartnerStore(db).getPartner(id))?.supportConfig;
  const audits = () => db.select().from(auditEvents).orderBy(asc(auditEvents.id));

  beforeEach(async () => {
    db = await freshDb();
    await seedPartner(db, 'pa', 'Partner A');
    await seedPartner(db, 'pb', 'Partner B');
    await db.update(partners).set({ supportConfig: { enableSupportPortal: true, autoAssign: 'round_robin', alertEmail: 'ops@acme.example', disclosure: DISCLOSURE } }).where(eq(partners.id, 'pa'));
  });

  it('setSupportPortal merges ONLY enableSupportPortal: autoAssign, alert email and disclosure kept', async () => {
    expect(await setSupportPortal(db, 'pa', actor, false)).toEqual({ ok: true });
    expect(await sc()).toEqual({ enableSupportPortal: false, autoAssign: 'round_robin', alertEmail: 'ops@acme.example', disclosure: DISCLOSURE });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId: 'pa', actor: 'pa-admin', actorType: 'staff', action: 'partner.support_config', subjectId: 'pa' });
    expect(rows[0].meta).toEqual({ old: { enableSupportPortal: true }, new: { enableSupportPortal: false }, actorScope: 'partner' });
  });

  it('setSupportKnobs (the legacy pair) records both old values, null when absent', async () => {
    await db.update(partners).set({ supportConfig: {} }).where(eq(partners.id, 'pa'));
    await setSupportKnobs(db, 'pa', { username: 'admin', actorScope: 'platform' }, { enableSupportPortal: true, autoAssign: 'none' });
    expect((await audits())[0].meta).toEqual({ old: { enableSupportPortal: null, autoAssign: null }, new: { enableSupportPortal: true, autoAssign: 'none' }, actorScope: 'platform' });
  });

  it('setAlertEmail sets and clears ONLY alertEmail; the audit row is boolean-only (no address)', async () => {
    expect(await setAlertEmail(db, 'pa', actor, 'alerts@acme.example')).toEqual({ ok: true });
    expect(await sc()).toEqual({ enableSupportPortal: true, autoAssign: 'round_robin', alertEmail: 'alerts@acme.example', disclosure: DISCLOSURE });
    expect(await setAlertEmail(db, 'pa', actor, null)).toEqual({ ok: true });
    expect(await sc()).toEqual({ enableSupportPortal: true, autoAssign: 'round_robin', disclosure: DISCLOSURE });
    const rows = await audits();
    expect(rows.map((r) => r.meta)).toEqual([
      { set: true, hadPrevious: true, actorScope: 'partner' },
      { set: false, hadPrevious: true, actorScope: 'partner' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('@');
  });

  it('setDisclosure replaces and clears ONLY the disclosure block, auditing old and new', async () => {
    const next = { licensedEntity: 'Acme Remit Inc' };
    expect(await setDisclosure(db, 'pa', actor, next)).toEqual({ ok: true });
    expect(await sc()).toEqual({ enableSupportPortal: true, autoAssign: 'round_robin', alertEmail: 'ops@acme.example', disclosure: next });
    expect(await setDisclosure(db, 'pa', actor, undefined)).toEqual({ ok: true });
    expect(await sc()).toEqual({ enableSupportPortal: true, autoAssign: 'round_robin', alertEmail: 'ops@acme.example' });
    const rows = await audits();
    expect(rows.map((r) => [r.action, r.meta])).toEqual([
      ['partner.disclosure_config', { old: DISCLOSURE, new: next, actorScope: 'partner' }],
      ['partner.disclosure_config', { old: next, new: null, actorScope: 'partner' }],
    ]);
  });

  it('an unknown partner → not_found: nothing written, no audit row, other tenants untouched', async () => {
    const pbBefore = await sc('pb');
    expect(await setSupportPortal(db, 'ghost', actor, true)).toEqual({ ok: false, reason: 'not_found' });
    expect(await setAlertEmail(db, 'ghost', actor, 'x@y.example')).toEqual({ ok: false, reason: 'not_found' });
    expect(await setDisclosure(db, 'ghost', actor, { licensedEntity: 'X' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await audits()).toEqual([]);
    expect(await sc('pb')).toEqual(pbBefore);
  });

  it('a writer inside the caller transaction rolls back with it (write + audit are one unit)', async () => {
    await expect(
      db.transaction(async (tx) => {
        await setSupportPortal(tx, 'pa', actor, false);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await sc())?.enableSupportPortal).toBe(true);
    expect(await audits()).toEqual([]);
  });
});
