// M4 PR-2: the WhatsApp template catalog the docs publish is code-true: names
// equal the constants, arity equals the param builders, and "sent today" equals
// whether a send path actually references the template.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const placeholders = (s: string) => new Set([...s.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;

function allSources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allSources(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe('WhatsApp template catalog is code-true', () => {
  it('fixed names equal the code constants (all 9), with no duplicates', async () => {
    const { TEMPLATES } = await import('@/content/docs/whatsapp-template-catalog');
    const t = await import('@/lib/whatsapp-templates');
    const w = await import('@/lib/whatsapp');
    const fixed = TEMPLATES.filter((x) => x.nameSource === 'fixed').map((x) => x.name).sort();
    expect(fixed).toEqual([
      w.RECIPIENT_TEMPLATE_NAME, t.TEMPLATE_TRANSFER_DELIVERED_SENDER, t.TEMPLATE_SCHEDULED_PAYMENT_READY,
      t.TEMPLATE_PAYMENT_REMINDER, t.TEMPLATE_TRANSFER_IN_REVIEW, t.TEMPLATE_TRANSFER_RELEASED,
      t.TEMPLATE_TRANSFER_CANCELLED, t.TEMPLATE_VERIFICATION_REMINDER, t.TEMPLATE_SCHEDULE_NAME_NEEDED,
    ].sort());
    expect(new Set(TEMPLATES.map((x) => x.name)).size).toBe(TEMPLATES.length);
    for (const e of TEMPLATES) expect(e.language).toBe(t.TEMPLATE_LANG);
  });

  it('paramCount equals the {{n}} count AND the builder output length', async () => {
    const { TEMPLATES } = await import('@/content/docs/whatsapp-template-catalog');
    const t = await import('@/lib/whatsapp-templates');
    const p = await import('@/lib/payment');
    const tr = {
      id: 'tx_1', phone: '12025550143', recipientName: 'Priya', amountInr: 4750, destinationCurrency: 'INR',
      totalChargeUsd: 50, totalChargeSource: 50, sourceCurrency: 'USD',
    } as never;
    const arity: Record<string, number> = {
      transfer_delivered: p.recipientTemplateParams(tr).length,
      transfer_delivered_sender: t.transferDeliveredSenderParams(tr).length,
      scheduled_payment_ready: t.scheduledPaymentReadyParams({ amountUsd: 100, recipientName: 'Priya' } as never, 'tx_1', 'Anand').bodyParams.length,
      payment_reminder: t.paymentReminderParams(tr, 'Anand').bodyParams.length,
      transfer_in_review: t.transferInReviewParams(tr, 'Anand').length,
      transfer_released: t.transferReleasedParams(tr, 'Anand').length,
      transfer_cancelled: t.transferCancelledParams(tr, 'Anand').length,
      verification_reminder: t.verificationReminderParams('Anand', 'sess_1').bodyParams.length,
      schedule_name_needed: t.scheduleNameNeededParams('Acme', { amountUsd: 200 } as never, Date.now()).length,
    };
    for (const e of TEMPLATES) {
      expect({ name: e.name, n: placeholders(e.body) }).toEqual({ name: e.name, n: e.paramCount });
      if (e.name in arity) expect({ name: e.name, n: arity[e.name] }).toEqual({ name: e.name, n: e.paramCount });
    }
    const verification = TEMPLATES.filter((x) => x.purpose.startsWith('Identity verification status'));
    expect(verification).toHaveLength(4);
    for (const v of verification) {
      expect(v.nameSource).toBe('configured');
      expect(v.paramCount).toBe(t.verificationStatusParams('Anand', 'needed').length);
    }
    const auth = TEMPLATES.filter((x) => x.category === 'AUTHENTICATION');
    expect(auth).toHaveLength(1);
    expect(auth[0].nameSource).toBe('configured');
    expect(auth[0].button).toEqual({ kind: 'copy-code' });
    // The auth template carries the code once in the body (and again in the copy-code button).
    expect(auth[0].paramCount).toBe(t.authenticationTemplateParams('000000').find((c) => c.type === 'body')!.parameters.length);
  });

  it('sentToday is true exactly for templates a send path references', async () => {
    const { TEMPLATES } = await import('@/content/docs/whatsapp-template-catalog');
    const srcs = allSources('src').filter((f) => !f.endsWith('whatsapp-templates.ts') && !f.includes(join('src', 'content')));
    // Comments and import/export-from statements are stripped, so a mention in a comment or a
    // bare import can never count as a send path; builders must be CALLED (name followed by '(').
    const stripComments = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
        .replace(/^\s*(?:import|export)\s[^;]*?\sfrom\s*['"][^'"]+['"];?/gm, '');
    const text = srcs.map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');
    const referenced: Record<string, boolean> = {
      transfer_delivered: /RECIPIENT_TEMPLATE_NAME/.test(text.replace(/export const RECIPIENT_TEMPLATE_NAME[^\n]*/, '')),
      scheduled_payment_ready: /TEMPLATE_SCHEDULED_PAYMENT_READY|SCHEDULED_TEMPLATE_NAME/.test(
        text.replace(/export const (TEMPLATE_SCHEDULED_PAYMENT_READY|SCHEDULED_TEMPLATE_NAME)[^\n]*/g, ''),
      ),
      transfer_delivered_sender: /transferDeliveredSenderParams\(|deliveredSenderTemplate\(|TEMPLATE_TRANSFER_DELIVERED_SENDER/.test(text),
      payment_reminder: /paymentReminderParams\(|TEMPLATE_PAYMENT_REMINDER/.test(text),
      transfer_in_review: /transferInReviewParams\(|inReviewTemplate\(|TEMPLATE_TRANSFER_IN_REVIEW/.test(text),
      transfer_released: /transferReleasedParams\(|TEMPLATE_TRANSFER_RELEASED/.test(text),
      transfer_cancelled: /transferCancelledParams\(|TEMPLATE_TRANSFER_CANCELLED/.test(text),
      verification_reminder: /verificationReminderParams\(|TEMPLATE_VERIFICATION_REMINDER/.test(text),
      schedule_name_needed: /scheduleNameNeeded(Params|Template)\(|TEMPLATE_SCHEDULE_NAME_NEEDED/.test(text),
    };
    for (const e of TEMPLATES.filter((x) => x.nameSource === 'fixed')) {
      expect({ name: e.name, sentToday: e.sentToday }).toEqual({ name: e.name, sentToday: referenced[e.name] });
    }
    // The configured (opt-in) verification and auth templates have live callers.
    // Strip the definitions so a bare declaration never counts as a caller.
    const callers = text.replace(/(export )?(async )?function (sendVerificationStatus|sendAuthTemplate)\(/g, '');
    expect(callers).not.toMatch(/function (sendVerificationStatus|sendAuthTemplate)\(/);
    expect(callers).toMatch(/sendVerificationStatus\(/);
    expect(callers).toMatch(/sendAuthTemplate\(/);
    for (const e of TEMPLATES.filter((x) => x.nameSource === 'configured')) expect(e.sentToday).toBe(true);
  });

  it('no template publishes a URL to a route that does not exist; verification_reminder is withheld', async () => {
    const { TEMPLATES } = await import('@/content/docs/whatsapp-template-catalog');
    const dirs = readdirSync('src/app');
    for (const e of TEMPLATES) {
      if (e.button?.kind !== 'url' || e.button.urlPattern === null) continue; // withheld URLs are skipped
      const path = new URL(e.button.urlPattern.replace('{{1}}', 'x')).pathname.split('/').filter(Boolean)[0];
      expect({ name: e.name, exists: dirs.includes(path) }).toEqual({ name: e.name, exists: true });
    }
    const vr = TEMPLATES.find((x) => x.name === 'verification_reminder');
    expect(vr?.button).toMatchObject({ kind: 'url', urlPattern: null });
  });

  it('SmartRemit branding (owner decision 2026-10-04): templates name SmartRemit, never a partner-brand placeholder', async () => {
    const { TEMPLATES, TEMPLATE_BRAND } = await import('@/content/docs/whatsapp-template-catalog');
    expect(TEMPLATE_BRAND).toBe('SmartRemit');
    for (const e of TEMPLATES) {
      const text = `${e.body} ${e.footer ?? ''} ${e.purpose}`;
      expect({ name: e.name, hit: /your brand/i.test(text) }).toEqual({ name: e.name, hit: false });
    }
    expect(TEMPLATES.some((e) => e.body.includes(TEMPLATE_BRAND))).toBe(true);
  });
});
