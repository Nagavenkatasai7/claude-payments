import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmail, emailConfigured } from '@/lib/email';

// Program-Fix 39 (domain-11): sendEmail reports an HONEST outcome. A skip is
// never indistinguishable from a send; a configured-and-failing send still
// THROWS so the outbox retry/dead-letter path is unchanged.

const { createTransportMock, sendMailMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn(async () => ({ messageId: 'x' }));
  return { sendMailMock, createTransportMock: vi.fn(() => ({ sendMail: sendMailMock })) };
});
vi.mock('nodemailer', () => ({ default: { createTransport: createTransportMock } }));

function configureSmtp(): void {
  vi.stubEnv('SMTP_HOST', 'smtp.example.test');
  vi.stubEnv('SMTP_USER', 'mailer@example.test');
  vi.stubEnv('SMTP_PASS', 'not-a-real-password');
}

beforeEach(() => {
  createTransportMock.mockClear();
  sendMailMock.mockClear();
  sendMailMock.mockImplementation(async () => ({ messageId: 'x' }));
  vi.stubEnv('SMTP_HOST', '');
  vi.stubEnv('SMTP_USER', '');
  vi.stubEnv('SMTP_PASS', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('emailConfigured', () => {
  it('is false unless ALL of SMTP_HOST / SMTP_USER / SMTP_PASS are present', () => {
    expect(emailConfigured()).toBe(false);
    vi.stubEnv('SMTP_HOST', 'smtp.example.test');
    vi.stubEnv('SMTP_USER', 'mailer@example.test');
    expect(emailConfigured()).toBe(false);
    vi.stubEnv('SMTP_PASS', 'x');
    expect(emailConfigured()).toBe(true);
  });
});

describe('sendEmail — honest outcome', () => {
  it("unset SMTP resolves 'skipped_unconfigured' and never builds a transport", async () => {
    await expect(sendEmail({ to: ['x@y.test'], subject: 's', text: 't' })).resolves.toBe('skipped_unconfigured');
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it("empty `to` resolves 'skipped_no_recipients' (configured SMTP, nothing sent)", async () => {
    configureSmtp();
    await expect(sendEmail({ to: ['', ''], subject: 's', text: 't' })).resolves.toBe('skipped_no_recipients');
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("unconfigured wins over no recipients (the config problem is the one to report)", async () => {
    await expect(sendEmail({ to: [], subject: 's', text: 't' })).resolves.toBe('skipped_unconfigured');
  });

  it("a configured send resolves 'sent'", async () => {
    configureSmtp();
    await expect(sendEmail({ to: ['x@y.test'], subject: 's', text: 't' })).resolves.toBe('sent');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('a configured send that fails still THROWS (the outbox retries it)', async () => {
    configureSmtp();
    sendMailMock.mockImplementation(async () => { throw new Error('550 relay denied'); });
    await expect(sendEmail({ to: ['x@y.test'], subject: 's', text: 't' })).rejects.toThrow('550');
  });
});
