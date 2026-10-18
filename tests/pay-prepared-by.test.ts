import { describe, it, expect } from 'vitest';
import { preparedByLine } from '@/lib/pay-prepared-by';

describe('preparedByLine (pay page, Stage C2)', () => {
  it('no marker → no line (every bot, portal and partner draft)', () => {
    expect(preparedByLine(undefined)).toBeNull();
  });
  it("names the app in quotes as the app's own name", () => {
    expect(preparedByLine({ clientId: 'agc_1', appName: 'Claude' })).toBe(
      'Prepared in “Claude”, an AI app you connected. Check every detail before you pay.',
    );
  });
  it('an empty or invisible-only name still says an AI app prepared it', () => {
    expect(preparedByLine({ clientId: 'agc_1', appName: '​ ' })).toBe(
      'Prepared in an AI app you connected. Check every detail before you pay.',
    );
  });
  it('a long name is clamped', () => {
    const line = preparedByLine({ clientId: 'agc_1', appName: 'x'.repeat(500) })!;
    expect(line.length).toBeLessThan(200);
  });
});
