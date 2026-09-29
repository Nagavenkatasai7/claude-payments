import { describe, it, expect } from 'vitest';
import {
  WA_SECRET_MAX,
  parseWhatsappForm,
  waErrorKey,
  maskPnid,
  healthItemsView,
  testResultView,
} from '@/lib/partner-whatsapp-view';
import { t } from '@/lib/i18n';

// UI redesign M3-13: the pure half of /partner/integrations/whatsapp. Edge validation (Meta id
// shapes, bounded secrets), the fixed error mapping, and the display projections (last 4 only,
// health by kind through i18n keys, never the summary's English text).

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe('parseWhatsappForm (validation at the edge)', () => {
  it('accepts an all-blank form (blank secrets keep the stored values)', () => {
    const r = parseWhatsappForm(fd({}));
    expect(r).toEqual({ ok: true, form: { phoneNumberId: '', token: '', verifyToken: '', appSecret: '', wabaId: '' } });
  });
  it('accepts Meta-shaped ids and trims every field', () => {
    const r = parseWhatsappForm(fd({ phoneNumberId: ' 1234567890123 ', wabaId: '987654321', token: ' EAAtok ', appSecret: 'sec', verifyToken: 'vt' }));
    expect(r).toEqual({ ok: true, form: { phoneNumberId: '1234567890123', token: 'EAAtok', verifyToken: 'vt', appSecret: 'sec', wabaId: '987654321' } });
  });
  it.each([
    ['phoneNumberId', '12ab5'],
    ['phoneNumberId', '1234'],
    ['phoneNumberId', '1'.repeat(21)],
    ['phoneNumberId', '../me'],
    ['wabaId', 'x1'],
    ['wabaId', '1'.repeat(31)],
    ['token', 'has space'],
    ['token', 'a'.repeat(WA_SECRET_MAX + 1)],
    ['appSecret', 'line\nbreak'],
    ['verifyToken', 'tab\there'],
  ])('refuses %s = %j, naming the field only', (field, value) => {
    const r = parseWhatsappForm(fd({ [field]: value }));
    expect(r).toEqual({ ok: false, field });
  });
  it('refuses a file upload in place of a text field', () => {
    const f = new FormData();
    f.set('token', new Blob(['x']), 'x.txt');
    expect(parseWhatsappForm(f)).toEqual({ ok: false, field: 'token' });
  });
  it('never reads a tenant field from the form', () => {
    const r = parseWhatsappForm(fd({ partnerId: 'pb', partner: 'pb', id: 'pb' }));
    expect(JSON.stringify(r)).not.toContain('pb');
  });
});

describe('waErrorKey (fixed copy per lib refusal)', () => {
  it('maps each code to its own key, and those keys exist', () => {
    const keys = (['number_unavailable', 'unverified', 'incomplete'] as const).map(waErrorKey);
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(t(k)).not.toBe(k);
  });
});

describe('maskPnid (last 4 only)', () => {
  it('shows only the last four digits', () => {
    expect(maskPnid('1234567890123')).toBe('••••0123');
    expect(maskPnid(undefined)).toBeNull();
    expect(maskPnid('')).toBeNull();
  });
});

describe('healthItemsView (i18n by kind, never the English summary text)', () => {
  it('projects kind, level and time only', () => {
    const v = healthItemsView({
      level: 'error',
      items: [
        { kind: 'auth_error', level: 'error', message: 'ENGLISH TEXT', at: '2026-09-28T10:11:00.000Z', count: 3, code: 190 },
        { kind: 'config_warning', level: 'warn', message: 'ENGLISH TEXT' },
      ],
    });
    expect(v.state).toBe('error');
    expect(v.items).toHaveLength(2);
    expect(JSON.stringify(v)).not.toContain('ENGLISH TEXT');
    expect(v.items[0]).toMatchObject({ level: 'error', when: '2026-09-28 10:11 UTC' });
    for (const i of v.items) expect(t(i.labelKey)).not.toBe(i.labelKey);
  });
  it('an ok summary has no items', () => {
    expect(healthItemsView({ level: 'ok', items: [] })).toEqual({ state: 'ok', items: [] });
  });
});

describe('testResultView', () => {
  it('covers not tested, passed, not configured and failed (status only)', () => {
    expect(testResultView(null).key).toBe('partner.whatsapp.test.never');
    expect(testResultView({ ok: true, at: '2026-09-28T10:11:00.000Z' })).toEqual({ key: 'partner.whatsapp.test.passed', vars: { when: '2026-09-28 10:11 UTC' }, ok: true });
    expect(testResultView({ ok: false, at: '2026-09-28T10:11:00.000Z', reason: 'not_configured' }).key).toBe('partner.whatsapp.test.notConfigured');
    expect(testResultView({ ok: false, at: '2026-09-28T10:11:00.000Z', reason: 'probe_failed', status: 401 })).toEqual({
      key: 'partner.whatsapp.test.failedStatus',
      vars: { when: '2026-09-28 10:11 UTC', status: 401 },
      ok: false,
    });
    expect(testResultView({ ok: false, at: '2026-09-28T10:11:00.000Z', reason: 'probe_failed' }).key).toBe('partner.whatsapp.test.failed');
  });
});
