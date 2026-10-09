import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CATALOG,
  DEFAULT_FESTIVAL_NAMES,
  adminFestivalNamesField,
  daySpan,
  festivalFormState,
  isCalendarDay,
  parseCatalogForm,
  parseFestivalNames,
  parsePartnerRewardForm,
  parseTermsForm,
  settingWithinLimits,
} from '@/lib/rewards/settings';

// B3 rewards v1: the form rules of /admin-dashboard/rewards and /partner/rewards.

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const NTH = { ...DEFAULT_CATALOG.nth_transfer, available: true };
const FEST = { ...DEFAULT_CATALOG.festival, available: true, festivalNames: ['Diwali', 'Holi'] };

describe('admin forms', () => {
  it('catalog: valid values parse; a reversed N range, a long name list or a bad amount is refused', () => {
    const ok = parseCatalogForm('festival', form({
      available: 'on', nthMin: '3', nthMax: '10', maxDays: '14', customerMonthlyCap: '1', maxDiscountUsd: '2.99', festivalNames: 'Diwali\nHoli, Diwali',
    }));
    expect(ok).toEqual({ ok: true, value: {
      kind: 'festival', available: true, nthMin: 3, nthMax: 10, maxDays: 14, maxDiscountUsd: 2.99, customerMonthlyCap: 1, festivalNames: ['Diwali', 'Holi'],
    } });
    expect(parseCatalogForm('nth_transfer', form({ nthMin: '8', nthMax: '4', maxDays: '14', customerMonthlyCap: '1', maxDiscountUsd: '2', festivalNames: '' })).ok).toBe(false);
    expect(parseCatalogForm('nth_transfer', form({ nthMin: '3', nthMax: '10', maxDays: '14', customerMonthlyCap: '1', maxDiscountUsd: '-1', festivalNames: '' })).ok).toBe(false);
    expect(parseFestivalNames('<script>')).toBeNull();
  });

  it('terms: amounts and a percentage', () => {
    expect(parseTermsForm(form({ platformFeeUsd: '0.60', giveBackPct: '40', monthlyBudgetUsd: '500' })))
      .toEqual({ ok: true, value: { platformFeeUsd: 0.6, giveBackPct: 40, monthlyBudgetUsd: 500 } });
    expect(parseTermsForm(form({ platformFeeUsd: '0.60', giveBackPct: '140', monthlyBudgetUsd: '500' })).ok).toBe(false);
    expect(parseTermsForm(form({ platformFeeUsd: 'x', giveBackPct: '40', monthlyBudgetUsd: '500' })).ok).toBe(false);
  });
});

describe('partner form: values only inside the admin limits', () => {
  it('every Nth: 3..10 accepted, outside refused; not available ⇒ cannot turn on', () => {
    expect(parsePartnerRewardForm('nth_transfer', form({ enabled: 'on', nth: '5' }), NTH)).toEqual({ ok: true, value: { kind: 'nth_transfer', enabled: true, nth: 5 } });
    expect(parsePartnerRewardForm('nth_transfer', form({ enabled: 'on', nth: '2' }), NTH).ok).toBe(false);
    expect(parsePartnerRewardForm('nth_transfer', form({ enabled: 'on', nth: '11' }), NTH).ok).toBe(false);
    expect(parsePartnerRewardForm('nth_transfer', form({ enabled: 'on', nth: '5' }), { ...NTH, available: false }).ok).toBe(false);
    // turning it off is always allowed
    expect(parsePartnerRewardForm('nth_transfer', form({ nth: '' }), { ...NTH, available: false }).ok).toBe(true);
  });

  it('festival: a listed name, real dates, at most the admin length', () => {
    const good = { enabled: 'on', festivalName: 'Diwali', startsOn: '2026-11-01', endsOn: '2026-11-14', minAmountUsd: '100' };
    expect(parsePartnerRewardForm('festival', form(good), FEST)).toEqual({ ok: true, value: {
      kind: 'festival', enabled: true, festivalName: 'Diwali', startsOn: '2026-11-01', endsOn: '2026-11-14', minAmountUsd: 100,
    } });
    expect(parsePartnerRewardForm('festival', form({ ...good, endsOn: '2026-11-15' }), FEST).ok).toBe(false); // 15 days
    expect(parsePartnerRewardForm('festival', form({ ...good, festivalName: 'Pongal' }), FEST).ok).toBe(false);
    expect(parsePartnerRewardForm('festival', form({ ...good, endsOn: '2026-10-30' }), FEST).ok).toBe(false);
    expect(parsePartnerRewardForm('festival', form({ ...good, startsOn: '2026-02-30' }), FEST).ok).toBe(false);
  });

  it('helpers', () => {
    expect(isCalendarDay('2026-02-28')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(daySpan('2026-11-01', '2026-11-01')).toBe(1);
    expect(daySpan('2026-11-01', '2026-11-14')).toBe(14);
    expect(settingWithinLimits({ kind: 'nth_transfer', enabled: false }, NTH)).toBe(true);
  });
});

describe('festival names list (follow-up Part B)', () => {
  it('the default list is the owner’s 16 festivals, in order, and the catalog default uses it', () => {
    expect(DEFAULT_FESTIVAL_NAMES).toEqual([
      'Diwali', 'Holi', 'Raksha Bandhan', 'Navratri', 'Durga Puja', 'Dussehra', 'Ganesh Chaturthi', 'Onam',
      'Pongal', 'Makar Sankranti', 'Ugadi', 'Baisakhi', 'Eid al-Fitr', 'Eid al-Adha', 'Christmas', 'New Year',
    ]);
    expect(DEFAULT_CATALOG.festival.festivalNames).toEqual([...DEFAULT_FESTIVAL_NAMES]);
    expect(DEFAULT_CATALOG.festival.available).toBe(false); // still dark until an admin saves it
    expect(DEFAULT_CATALOG.nth_transfer.festivalNames).toEqual([]);
    expect(Object.isFrozen(DEFAULT_FESTIVAL_NAMES)).toBe(true);
  });

  it('the default list passes the admin form rules unchanged (Save on the prefilled textarea works)', () => {
    expect(parseFestivalNames(DEFAULT_FESTIVAL_NAMES.join('\n'))).toEqual([...DEFAULT_FESTIVAL_NAMES]);
  });

  it('admin textarea: an empty saved list is prefilled with the defaults and flagged as a suggestion', () => {
    expect(adminFestivalNamesField([])).toEqual({ text: DEFAULT_FESTIVAL_NAMES.join('\n'), suggested: true });
    expect(adminFestivalNamesField(['Diwali', 'Holi'])).toEqual({ text: 'Diwali\nHoli', suggested: false });
  });

  it('partner festival card: unavailable, no festivals yet, or the form', () => {
    const on = { kind: 'festival' as const, enabled: true, festivalName: 'Diwali' };
    expect(festivalFormState({ ...FEST, available: false }, undefined)).toBe('unavailable');
    expect(festivalFormState({ ...FEST, available: false, festivalNames: [] }, undefined)).toBe('unavailable');
    expect(festivalFormState({ ...FEST, festivalNames: [] }, undefined)).toBe('no_festivals');
    expect(festivalFormState({ ...FEST, festivalNames: [] }, on)).toBe('no_festivals');
    expect(festivalFormState(FEST, undefined)).toBe('form');
    // an offer already on stays editable when SmartRemit later turns the reward off (it can be switched off)
    expect(festivalFormState({ ...FEST, available: false }, on)).toBe('form');
  });
});
