import { describe, it, expect } from 'vitest';
import { buildStaffInviteEmail, STAFF_INVITE_LINK_PLACEHOLDER, staffInviteDedupeKey } from '@/lib/staff-invite-email';
import { renderSealedText } from '@/lib/sealed-text';
import { encryptField } from '@/lib/field-crypto';
import { outboxSealedCtx } from '@/lib/crypto-context';

// UI redesign M3-8: the staff-invite email. The link is NEVER in the text: it is a placeholder the
// worker renders from a field-crypto SEALED value at send time (sealed-text.ts, fix 11).
describe('staff invite email', () => {
  it('the placeholder is the literal staff_invite_link (the sealed-text [a-z_]+ grammar)', () => {
    expect(STAFF_INVITE_LINK_PLACEHOLDER).toBe('staff_invite_link');
    expect(STAFF_INVITE_LINK_PLACEHOLDER).toMatch(/^[a-z_]+$/);
  });
  it('the text carries the placeholder and no URL; the copy is constant (no tenant-supplied text)', () => {
    const e = buildStaffInviteEmail();
    expect(e.text).toContain('{{staff_invite_link}}');
    expect(e.text).not.toMatch(/https?:\/\//);
    expect(e.text).not.toContain('/partner/invite/');
    expect(buildStaffInviteEmail()).toEqual(e);
    expect(e.subject.length).toBeGreaterThan(0);
    expect(e.text).toMatch(/72 hours/);
  });
  it('the dedupe key is the hash prefix under its own prefix, never the token', () => {
    const hash = 'ab'.repeat(32);
    expect(staffInviteDedupeKey(hash)).toBe(`staff_invite:${hash.slice(0, 12)}`);
  });
  it('the worker renders the sealed link under its purpose context', () => {
    const link = 'https://smartremit.test/partner/invite/' + 'A'.repeat(43);
    const sealed = { staff_invite_link: encryptField(link, undefined, outboxSealedCtx('staff_invite_link')) };
    expect(renderSealedText(buildStaffInviteEmail().text, sealed)).toContain(link);
  });
});
