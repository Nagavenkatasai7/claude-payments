import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync } from 'node:fs';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('@/lib/log');
  vi.resetModules();
});

describe('t()', () => {
  it('returns the en string and interpolates {vars}', async () => {
    const { t } = await import('@/lib/i18n');
    expect(t('ds.error.retry')).toBe('Try again');
    expect(t('ds.table.pageOf', { page: 2, pages: 5 })).toBe('Page 2 of 5');
  });
  it('an unknown key throws outside production (missing keys fail loudly)', async () => {
    const { t, MissingMessageError } = await import('@/lib/i18n');
    expect(() => t('nope.missing' as never)).toThrow(MissingMessageError);
  });
  it('a missing {var} throws outside production', async () => {
    const { t, MissingMessageError } = await import('@/lib/i18n');
    expect(() => t('ds.table.pageOf', { page: 1 })).toThrow(MissingMessageError);
  });
  it('in production an unknown key returns the key (never crashes a page) and logs', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const warn = vi.fn();
    // The namespace-spy form is not reliable under ESM; mock the module the way other suites do.
    vi.doMock('@/lib/log', async (orig) => ({ ...((await orig()) as object), logWarn: warn }));
    const { t } = await import('@/lib/i18n');
    expect(t('nope.missing' as never)).toBe('nope.missing');
    expect(warn).toHaveBeenCalled();
  });
  it('in production a missing {var} renders empty instead of throwing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { t } = await import('@/lib/i18n');
    expect(t('ds.table.pageOf', { page: 1 })).toBe('Page 1 of ');
  });
  it('the output is plain text: vars are not HTML-interpreted (React escapes at render)', async () => {
    const { t } = await import('@/lib/i18n');
    expect(t('ds.table.pageOf', { page: '<b>1</b>', pages: 1 })).toBe('Page <b>1</b> of 1');
  });
});

describe('catalogues', () => {
  it('every file in catalogues/ is registered, and every locale has exactly en’s keys', async () => {
    const { CATALOGUES } = await import('@/lib/i18n/catalogues');
    const files = readdirSync('src/lib/i18n/catalogues')
      .filter((f) => f !== 'index.ts')
      .map((f) => f.replace(/\.ts$/, ''));
    expect(Object.keys(CATALOGUES).sort()).toEqual(files.sort());
    const enKeys = Object.keys(CATALOGUES.en).sort();
    for (const [loc, cat] of Object.entries(CATALOGUES)) expect(Object.keys(cat).sort(), loc).toEqual(enKeys);
  });
  it('transfer status labels equal the customer portal’s today (one mapping, no drift)', async () => {
    const { t } = await import('@/lib/i18n');
    const { transferStatusLabel } = await import('@/app/account/format');
    for (const s of ['awaiting_payment', 'paid', 'in_review', 'delivered', 'cancelled', 'blocked'] as const) {
      expect(t(`status.transfer.${s}`)).toBe(transferStatusLabel({ status: s, refundStatus: undefined }));
    }
    for (const r of ['requested', 'pending', 'completed'] as const) {
      expect(t(`status.refund.${r}`)).toBe(transferStatusLabel({ status: 'paid', refundStatus: r }));
    }
  });
});
