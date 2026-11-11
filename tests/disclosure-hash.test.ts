import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

// Fix pack 4 T5 (C11): the 'dh1:' hash of a stored provider block. The hash is
// what a partner admin's approval stamps (approval.hash) and what the pay page
// will later post back, so it must be canonical: key order in the jsonb never
// changes it, the approval stamp itself is not part of it, and every other
// field is. Imports are dynamic so each case fails on its own while red.

const mod = () => import('@/lib/disclosure-hash');

const FULL = {
  licensedEntity: 'Acme Money Services LLC',
  licenseIds: ['NMLS 000000', 'CA 12345'],
  phone: '+1 800 555 0100',
  website: 'https://acme.example',
  stateRegulator: { name: 'State Department of Financial Services', phone: '+1 800 555 0199', website: 'https://regulator.example' },
  deliveryEstimate: { businessDays: 2 },
};

// The canonical form, written out: keys sorted at every depth, arrays in order.
const CANONICAL =
  '{"deliveryEstimate":{"businessDays":2},' +
  '"licenseIds":["NMLS 000000","CA 12345"],' +
  '"licensedEntity":"Acme Money Services LLC",' +
  '"phone":"+1 800 555 0100",' +
  '"stateRegulator":{"name":"State Department of Financial Services","phone":"+1 800 555 0199","website":"https://regulator.example"},' +
  '"website":"https://acme.example"}';

describe('disclosureHash (C11)', () => {
  it("DISCLOSURE_HASH_VERSION is 'dh1' and the hash is 'dh1:' + 64 lowercase hex", async () => {
    const { DISCLOSURE_HASH_VERSION, disclosureHash } = await mod();
    expect(DISCLOSURE_HASH_VERSION).toBe('dh1');
    expect(disclosureHash(FULL)).toMatch(/^dh1:[0-9a-f]{64}$/);
  });

  it("pinned fixture: a full block hashes to 'dh1:' + sha256(<the canonical string>)", async () => {
    const { disclosureHash } = await mod();
    const expected = `dh1:${createHash('sha256').update(CANONICAL, 'utf8').digest('hex')}`;
    expect(disclosureHash(FULL)).toBe(expected);
    expect(disclosureHash(FULL)).toBe('dh1:0dad27b8e9010cf4b1ccbe160996ed9c2dc45bcdc5ca2d1b39a0a8d9b81cf7d3');
  });

  it('the same block in shuffled key order (top level and stateRegulator) hashes equal', async () => {
    const { disclosureHash } = await mod();
    const shuffled = {
      website: 'https://acme.example',
      deliveryEstimate: { businessDays: 2 },
      stateRegulator: { website: 'https://regulator.example', name: 'State Department of Financial Services', phone: '+1 800 555 0199' },
      phone: '+1 800 555 0100',
      licenseIds: ['NMLS 000000', 'CA 12345'],
      licensedEntity: 'Acme Money Services LLC',
    };
    expect(disclosureHash(shuffled)).toBe(disclosureHash(FULL));
  });

  it('the top-level approval key is ignored; any other field change (one licence id, the phone, the days) changes the hash', async () => {
    const { disclosureHash } = await mod();
    const base = disclosureHash(FULL);
    expect(disclosureHash({ ...FULL, approval: { by: 'ana', at: new Date().toISOString(), hash: base } })).toBe(base);
    expect(disclosureHash({ ...FULL, approval: 'junk' })).toBe(base);
    expect(disclosureHash({ ...FULL, licenseIds: ['NMLS 000000', 'CA 12346'] })).not.toBe(base);
    expect(disclosureHash({ ...FULL, licenseIds: ['CA 12345', 'NMLS 000000'] })).not.toBe(base);
    expect(disclosureHash({ ...FULL, phone: '+1 800 555 0101' })).not.toBe(base);
    expect(disclosureHash({ ...FULL, deliveryEstimate: { businessDays: 3 } })).not.toBe(base);
    // A nested approval key is data, not the stamp: it counts.
    expect(disclosureHash({ ...FULL, stateRegulator: { ...FULL.stateRegulator, approval: 'x' } })).not.toBe(base);
  });

  it('never throws on a non-object block (the jsonb is untyped)', async () => {
    const { disclosureHash } = await mod();
    for (const v of [null, undefined, 'x', 42, ['a']]) expect(disclosureHash(v)).toMatch(/^dh1:[0-9a-f]{64}$/);
  });
});
