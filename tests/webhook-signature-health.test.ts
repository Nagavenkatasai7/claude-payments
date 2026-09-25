import { describe, it, expect, vi, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import {
  noteSignatureFailure,
  noteSignedOk,
  readSignatureHealth,
  signatureAlarm,
  signedWebhookLabel,
  SIG_FAIL_CLAIM_TTL_SEC,
} from '@/lib/webhook-signature-health';
import { summarizeChannelHealth } from '@/lib/channel-health';

// R2b: inbound webhook signature health. A signature failure is UNAUTHENTICATED
// traffic, so it may only touch a bounded, deduped Redis mark per (partner,
// hour) — never a DB row, never an email. A valid signature records
// lastSignedOkAt, and the banner shows a signature problem only when failures
// are recent AND no valid delivery arrived in the last 24h.

const NOW = new Date('2026-09-25T10:15:00.000Z');
const HOUR = Math.floor(NOW.getTime() / 3_600_000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

afterEach(() => vi.restoreAllMocks());

describe('noteSignatureFailure (Redis only, one write per partner-hour)', () => {
  it('N failures in one hour ⇒ one claim key + one last-seen key + one log line', async () => {
    const redis = fakeRedis();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 25; i++) await noteSignatureFailure('acme', { redis, now: () => NOW });
    expect([...redis.dump.keys()].sort()).toEqual([`wasigfail:acme:${HOUR}`, 'wasigfaillast:acme']);
    expect(redis.dump.get('wasigfaillast:acme')).toBe(NOW.toISOString());
    const lines = warn.mock.calls.flat().map(String).filter((l) => l.includes('whatsapp.sig_fail'));
    expect(lines).toHaveLength(1);
  });

  it('the claim is SET NX with a bounded TTL', async () => {
    const redis = fakeRedis();
    const set = vi.spyOn(redis, 'set');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await noteSignatureFailure('acme', { redis, now: () => NOW });
    expect(set.mock.calls[0]).toEqual([`wasigfail:acme:${HOUR}`, '1', { ex: SIG_FAIL_CLAIM_TTL_SEC, nx: true }]);
    expect(SIG_FAIL_CLAIM_TTL_SEC).toBeLessThanOrEqual(2 * 3600);
  });

  it('a new hour ⇒ a new claim and an updated last-seen', async () => {
    const redis = fakeRedis();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await noteSignatureFailure('acme', { redis, now: () => NOW });
    const later = new Date(NOW.getTime() + 3_600_000);
    await noteSignatureFailure('acme', { redis, now: () => later });
    expect(redis.dump.get('wasigfaillast:acme')).toBe(later.toISOString());
  });

  it('the default tenant and an empty id ⇒ nothing', async () => {
    const redis = fakeRedis();
    await noteSignatureFailure('default', { redis, now: () => NOW });
    await noteSignatureFailure('', { redis, now: () => NOW });
    expect(redis.dump.size).toBe(0);
  });

  it('a Redis failure never throws', async () => {
    const redis = fakeRedis();
    vi.spyOn(redis, 'set').mockRejectedValue(new Error('redis down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(noteSignatureFailure('acme', { redis, now: () => NOW })).resolves.toBeUndefined();
  });
});

describe('noteSignedOk / readSignatureHealth', () => {
  it('records the last valid signature time; read returns both marks', async () => {
    const redis = fakeRedis();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await noteSignedOk('acme', { redis, now: () => NOW });
    await noteSignatureFailure('acme', { redis, now: () => NOW });
    expect(await readSignatureHealth('acme', { redis })).toEqual({ lastOkAt: NOW.toISOString(), lastFailAt: NOW.toISOString() });
    expect(await readSignatureHealth('beta', { redis })).toEqual({});
  });

  it('the default tenant is never marked; a Redis failure never throws', async () => {
    const redis = fakeRedis();
    await noteSignedOk('default', { redis, now: () => NOW });
    expect(redis.dump.size).toBe(0);
    vi.spyOn(redis, 'set').mockRejectedValue(new Error('down'));
    vi.spyOn(redis, 'get').mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(noteSignedOk('acme', { redis, now: () => NOW })).resolves.toBeUndefined();
    await expect(readSignatureHealth('acme', { redis })).resolves.toEqual({});
  });
});

describe('signatureAlarm (a failure can be forged, a success cannot)', () => {
  it('recent failures but never a valid delivery ⇒ NO alarm (the "no signed webhook" row covers that)', () => {
    expect(signatureAlarm({ lastFailAt: hoursAgo(1) }, NOW)).toBe(false);
    expect(signatureAlarm({ lastFailAt: hoursAgo(1), lastOkAt: 'garbage' }, NOW)).toBe(false);
  });
  it('recent failures but a valid delivery within 24h ⇒ no alarm', () => {
    expect(signatureAlarm({ lastFailAt: hoursAgo(0), lastOkAt: hoursAgo(23) }, NOW)).toBe(false);
  });
  it('recent failures and the last valid delivery older than 24h ⇒ alarm', () => {
    expect(signatureAlarm({ lastFailAt: hoursAgo(1), lastOkAt: hoursAgo(25) }, NOW)).toBe(true);
  });
  it('no failure in the last 24h ⇒ no alarm; junk timestamps ⇒ no alarm', () => {
    expect(signatureAlarm({ lastFailAt: hoursAgo(25) }, NOW)).toBe(false);
    expect(signatureAlarm({}, NOW)).toBe(false);
    expect(signatureAlarm({ lastFailAt: 'garbage' }, NOW)).toBe(false);
  });
});

describe('summarizeChannelHealth — the signature item', () => {
  const MSG =
    "Some inbound webhook calls failed signature checks. If your bot isn't receiving messages, check the app secret.";

  it('alarm ⇒ one sig_fail WARN item (never an error banner), worded as a hint', () => {
    const s = summarizeChannelHealth({ marks: {}, now: NOW, signature: { lastFailAt: hoursAgo(1), lastOkAt: hoursAgo(25) } });
    expect(s.level).toBe('warn');
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toEqual({ kind: 'sig_fail', level: 'warn', message: MSG, at: hoursAgo(1) });
  });

  it('never a signed-ok delivery ⇒ no signature item at all', () => {
    const s = summarizeChannelHealth({ marks: {}, now: NOW, signature: { lastFailAt: hoursAgo(1) } });
    expect(s).toEqual({ level: 'ok', items: [] });
  });

  it('failures while valid deliveries continue ⇒ no item (cannot be inflated into a banner)', () => {
    const s = summarizeChannelHealth({ marks: {}, now: NOW, signature: { lastFailAt: hoursAgo(0), lastOkAt: hoursAgo(0) } });
    expect(s).toEqual({ level: 'ok', items: [] });
  });

  it('a sig_fail Redis mark alone never shows: the signature gate is the only source', () => {
    const s = summarizeChannelHealth({ marks: { sig_fail: { at: hoursAgo(0), count: 9 } }, now: NOW });
    expect(s.items).toEqual([]);
  });
});

describe('signedWebhookLabel (the partner page row)', () => {
  it('no ok mark (the mark lives 30 days) ⇒ "No signed webhook recorded in the last 30 days"', () => {
    expect(signedWebhookLabel({})).toBe('No signed webhook recorded in the last 30 days');
    expect(signedWebhookLabel({ lastFailAt: hoursAgo(1) })).toBe('No signed webhook recorded in the last 30 days');
  });
  it('an ok mark ⇒ its UTC minute', () => {
    expect(signedWebhookLabel({ lastOkAt: NOW.toISOString() })).toBe('Last signed webhook · 2026-09-25 10:15 UTC');
  });
});
