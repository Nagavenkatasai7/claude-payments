import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StepUpPrompt } from '@/app/partner/(app)/integrations/step-up';
import { STEP_UP_FIELD } from '@/lib/staff-step-up-result';
import { t } from '@/lib/i18n';

// The inline re-verify shown when a /partner credential action returns step_up_required. The
// secret input carries NO name (it never rides a native form submission; the retry adds it to a
// copy of the kept submission), the TOTP variant is a one-time-code field and the password variant
// a current-password field, and the server's fixed copy is the alert.

const render = (factor: 'totp' | 'password', error: string) =>
  renderToStaticMarkup(
    createElement(StepUpPrompt, { stepUp: { ok: false, code: 'step_up_required', factor, error }, onSubmit: () => {}, onCancel: () => {}, pending: false }),
  );

describe('StepUpPrompt', () => {
  it('TOTP: a numeric one-time-code field, the title, the server copy as the alert', () => {
    const html = render('totp', t('partner.stepUp.required.totp'));
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain(t('partner.stepUp.title'));
    expect(html).toContain(t('partner.stepUp.label.totp'));
    expect(html).toMatch(/role="alert"[^>]*>For your security, enter the 6-digit code/);
    expect(html).not.toContain('type="password"');
  });
  it('password: a current-password field', () => {
    const html = render('password', t('partner.stepUp.required.password'));
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain(t('partner.stepUp.label.password'));
  });
  it('the secret input has no name, so it never rides a native submission', () => {
    for (const f of ['totp', 'password'] as const) {
      const html = render(f, 'x');
      expect(html).not.toContain(`name="${STEP_UP_FIELD}"`);
      expect(html).not.toMatch(/<input[^>]*\sname=/);
    }
  });
});
