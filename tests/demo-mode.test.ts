import { describe, it, expect, vi, afterEach } from 'vitest';
import { demoModeLabel, demoModeSummary, demoPhoneList, inDemo, phoneInList } from '@/lib/demo-mode';

// Demo mode: ONE env list (DEMO_PHONES) decides which phones see new beta
// features; each feature keeps its own feature_flags switch. Phones are fakes.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('phoneInList (pure)', () => {
  it("'*' alone is everyone; '*' inside a longer list is not", () => {
    expect(phoneInList('15550000001', ['*'])).toBe(true);
    expect(phoneInList('15550000001', ['*', '15550000009'])).toBe(false);
  });

  it('compares digits only: + spaces and dashes are normalised', () => {
    expect(phoneInList('15550000001', ['+1 555-000-0001'])).toBe(true);
    expect(phoneInList('+1 (555) 000-0001', ['15550000001'])).toBe(true);
    expect(phoneInList('15550000002', ['15550000001'])).toBe(false);
  });

  it('an empty sender, an empty list or junk entries never match', () => {
    expect(phoneInList('', ['*'])).toBe(false);
    expect(phoneInList('', [''])).toBe(false);
    expect(phoneInList('15550000001', [])).toBe(false);
    expect(phoneInList('15550000001', ['abc'])).toBe(false);
  });
});

describe('demoPhoneList / inDemo (env at call time)', () => {
  it('DEMO_PHONES wins over the legacy VOICE_NOTES_BETA_PHONES', () => {
    vi.stubEnv('DEMO_PHONES', '15550000002');
    vi.stubEnv('VOICE_NOTES_BETA_PHONES', '*');
    expect(demoPhoneList()).toEqual(['15550000002']);
    expect(inDemo('15550000002')).toBe(true);
    expect(inDemo('15550000001')).toBe(false);
  });

  it('an empty DEMO_PHONES falls back to VOICE_NOTES_BETA_PHONES', () => {
    vi.stubEnv('DEMO_PHONES', '');
    vi.stubEnv('VOICE_NOTES_BETA_PHONES', '15550000001');
    expect(demoPhoneList()).toEqual(['15550000001']);
    expect(inDemo('+1 555 000 0001')).toBe(true);
    expect(inDemo('15550000002')).toBe(false);
  });

  it('both empty is nobody', () => {
    vi.stubEnv('DEMO_PHONES', '');
    vi.stubEnv('VOICE_NOTES_BETA_PHONES', '');
    expect(demoPhoneList()).toEqual([]);
    expect(inDemo('15550000001')).toBe(false);
  });

  it('an explicit list argument overrides the env', () => {
    vi.stubEnv('DEMO_PHONES', '*');
    expect(inDemo('15550000001', [])).toBe(false);
    expect(inDemo('15550000001', ['15550000001'])).toBe(true);
  });
});

describe('demoModeSummary (never the numbers)', () => {
  it("'*' is everyone", () => {
    vi.stubEnv('DEMO_PHONES', '*');
    expect(demoModeSummary()).toEqual({ kind: 'everyone', count: 0 });
  });

  it('a list reports its size only', () => {
    vi.stubEnv('DEMO_PHONES', '15550000001,15550000002, 15550000003');
    const s = demoModeSummary();
    expect(s).toEqual({ kind: 'list', count: 3 });
    expect(JSON.stringify(s)).not.toContain('1555');
  });

  it('nothing set is nobody; the legacy list counts when DEMO_PHONES is empty', () => {
    vi.stubEnv('DEMO_PHONES', '');
    vi.stubEnv('VOICE_NOTES_BETA_PHONES', '');
    expect(demoModeSummary()).toEqual({ kind: 'nobody', count: 0 });
    vi.stubEnv('VOICE_NOTES_BETA_PHONES', '15550000001');
    expect(demoModeSummary()).toEqual({ kind: 'list', count: 1 });
  });

  it("'*' inside a list is a list (it does not mean everyone)", () => {
    vi.stubEnv('DEMO_PHONES', '*,15550000001');
    expect(demoModeSummary()).toEqual({ kind: 'list', count: 2 });
  });
});

describe('demoModeLabel (the switches page line)', () => {
  it('names the kind and the count, never a number', () => {
    expect(demoModeLabel({ kind: 'everyone', count: 0 })).toBe('Demo mode: everyone');
    expect(demoModeLabel({ kind: 'list', count: 3 })).toBe('Demo mode: 3 phones');
    expect(demoModeLabel({ kind: 'list', count: 1 })).toBe('Demo mode: 1 phone');
    expect(demoModeLabel({ kind: 'nobody', count: 0 })).toBe('Demo mode: nobody');
  });
});
