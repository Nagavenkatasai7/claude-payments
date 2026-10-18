import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bankDetailsLocked, payOtpBudgetKind, preparedByLine } from '@/lib/pay-prepared-by';

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

describe('app-prepared drafts on the pay route (Stage C2 security review)', () => {
  const marker = { clientId: 'agc_1', appName: 'Claude' };
  it('bank details are locked only for an app-prepared draft', () => {
    expect(bankDetailsLocked({ preparedBy: marker })).toBe(true);
    expect(bankDetailsLocked({})).toBe(false);
    expect(bankDetailsLocked(null)).toBe(false);
  });
  it("an app-prepared draft's codes come from their own daily budget, apart from the customer's pay codes", () => {
    expect(payOtpBudgetKind({ preparedBy: marker })).toBe('agent');
    expect(payOtpBudgetKind({})).toBe('pay');
    expect(payOtpBudgetKind(null)).toBe('pay');
  });
  it('the pay route uses both (wiring pin)', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/pay/[transferId]/route.ts'), 'utf8');
    expect(src).toMatch(/hasSubmittedFields && bankDetailsLocked\(otpDraft\)/);
    expect(src).toMatch(/kind: payOtpBudgetKind\(otpDraft\)/);
  });
});
