/**
 * Program-Fix 22 (Task 12) — the SYNC settlement-URL rule and the address
 * classifier. Pure: no DNS, no network. Every settlement/reverse instruction
 * (decrypted PII on the wire) is gated by these two functions before any
 * socket opens; the same rule runs at save time, at routing and at pay time.
 */
import { describe, it, expect } from 'vitest';
import { checkSettlementUrl, isPublicAddress, safeProviderRef } from '@/lib/settlement-url';

const PROD = { appOrigin: 'https://smartremit.ai', production: true };
const DEV = { appOrigin: 'http://localhost:3000', production: false };

function reasonOf(raw: string, opts = PROD): string {
  const r = checkSettlementUrl(raw, opts);
  return r.ok ? 'OK' : r.reason;
}

describe('checkSettlementUrl — rejections (acceptance test 1)', () => {
  it.each([
    ['http://rail.acme.com', 'scheme'],
    ['ftp://rail.acme.com/settle', 'scheme'],
    ['https://169.254.169.254/latest', 'ip_literal'],
    ['https://2130706433/', 'ip_literal'], // WHATWG normalises to 127.0.0.1
    ['https://0x7f.1/', 'ip_literal'],
    ['https://[::1]/', 'ip_literal'],
    ['https://[fd00::1]/', 'ip_literal'],
    ['https://[::ffff:127.0.0.1]/', 'ip_literal'],
    ['https://user:pw@rail.acme.com', 'userinfo'],
    ['https://rail.acme.com:8443', 'port'],
    ['https://localhost/', 'internal_host'],
    ['https://api.localhost/', 'internal_host'],
    ['https://svc.internal/', 'internal_host'],
    ['https://printer.local/', 'internal_host'],
    ['https://box.home.arpa/', 'internal_host'],
    ['https://rail.acme.com./', 'internal_host'], // trailing dot ⇒ search-list bypass
    ['https://metadata/', 'single_label'],
    ['https://x/', 'single_label'],
    ['https://a..b/', 'unparseable'],
    [' ', 'unparseable'],
    ['', 'unparseable'],
    ['not a url', 'unparseable'],
  ])('%s ⇒ %s', (raw, reason) => {
    expect(reasonOf(raw)).toBe(reason);
  });

  it('a URL longer than 2048 characters is too_long (checked before parsing)', () => {
    expect(reasonOf(`https://rail.acme.com/${'a'.repeat(2100)}`)).toBe('too_long');
  });

  it('userinfo is refused even on the app origin (checked before the origin exception)', () => {
    expect(reasonOf('http://u:p@localhost:3000/api/partner-rail', DEV)).toBe('userinfo');
  });

  it('a private-IP http URL is refused as scheme (test 7 pins this exact reason)', () => {
    expect(reasonOf('http://10.0.0.5/settle', DEV)).toBe('scheme');
    expect(reasonOf('http://10.0.0.5/settle', PROD)).toBe('scheme');
  });
});

describe('checkSettlementUrl — acceptances (acceptance test 2)', () => {
  it('a public https host on the default port passes', () => {
    const r = checkSettlementUrl('https://rail.acme.com/settle', PROD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url.hostname).toBe('rail.acme.com');
      expect(r.appOrigin).toBe(false);
    }
  });

  it('an explicit :443 is the default port and passes', () => {
    expect(reasonOf('https://rail.acme.com:443/settle')).toBe('OK');
  });

  it('reserved test TLDs pass the sync rule (fixtures stay green; DNS refuses them later)', () => {
    expect(reasonOf('https://rail.example/settle')).toBe('OK');
    expect(reasonOf('https://rail.test/x')).toBe('OK');
    expect(reasonOf('https://smartremit.test/api/partner-rail')).toBe('OK');
  });

  it('the production app origin passes the NORMAL rule (no exception applied)', () => {
    const r = checkSettlementUrl('https://smartremit.ai/api/partner-rail', PROD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appOrigin).toBe(false);
  });

  it('the dev app origin over http passes ONLY when not production, flagged appOrigin', () => {
    const dev = checkSettlementUrl('http://localhost:3000/api/partner-rail', DEV);
    expect(dev.ok).toBe(true);
    if (dev.ok) expect(dev.appOrigin).toBe(true);
    const prod = checkSettlementUrl('http://localhost:3000/api/partner-rail', {
      appOrigin: 'http://localhost:3000',
      production: true,
    });
    expect(prod.ok).toBe(false);
    if (!prod.ok) expect(prod.reason).toBe('scheme');
  });

  it('the app-origin exception is an EXACT origin match (port and host)', () => {
    expect(reasonOf('http://localhost:3001/api/partner-rail', DEV)).toBe('scheme');
    expect(reasonOf('http://127.0.0.1:3000/api/partner-rail', DEV)).toBe('scheme');
    expect(reasonOf('http://localhost/api/partner-rail', DEV)).toBe('scheme');
  });

  it('an unparseable app origin never grants an exception', () => {
    expect(reasonOf('http://localhost:3000/x', { appOrigin: 'nonsense', production: false })).toBe('scheme');
  });
});

describe('isPublicAddress — address classes (acceptance test 3)', () => {
  it.each([
    '0.0.0.0', '0.1.2.3',
    '10.0.0.5', '10.255.255.255',
    '100.64.0.1', '100.127.255.254',
    '127.0.0.1', '127.255.255.255',
    '169.254.169.254',
    '172.16.0.1', '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1', // TEST-NET-1
    '192.88.99.1', // 6to4 relay anycast
    '192.168.1.1',
    '198.18.0.1', '198.19.255.255',
    '198.51.100.1', // TEST-NET-2
    '203.0.113.1', // TEST-NET-3
    '224.0.0.1', '239.255.255.255',
    '240.0.0.1', '255.255.255.255',
  ])('IPv4 %s is NOT public', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    '2002:7f00:1::', // 6to4 embedding 127.0.0.1
    '2002:808:808::', // 6to4 embedding 8.8.8.8 — refused whatever it embeds
    '2001:0:4136:e378::1', // Teredo
    '2001:db8::1', // documentation
    '3fff::1', // documentation (RFC 9637)
    '64:ff9b:1::1', // local-use NAT64
    '::7f00:1', // ::/96 v4-compatible
    '::ffff:7f00:1', // v4-mapped loopback
    '::ffff:10.0.0.5', // v4-mapped RFC1918 (dotted tail)
    '::', '::1',
    'fd00::1', 'fc00::1',
    'fe80::1',
    'ff02::1',
    '64:ff9b::7f00:1', // NAT64 embedding 127.0.0.1
  ])('IPv6 %s is NOT public', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '198.20.0.1',
    '::ffff:8.8.8.8', '::ffff:808:808',
    '64:ff9b::808:808', // NAT64 embedding 8.8.8.8
    '2606:4700::1111',
    '2001:4860:4860::8888', // outside 2001::/23
    '2a00:1450:4001:80b::200e',
  ])('%s IS public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it('garbage is never public (fail closed)', () => {
    for (const bad of ['', ' ', 'localhost', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', 'fe80::1%eth0', ':::', '1:2:3:4:5:6:7:8:9', 'g::1']) {
      expect(isPublicAddress(bad), bad).toBe(false);
    }
  });
});

describe('safeProviderRef — the rail ack field the ledger stores write-once (test 9)', () => {
  it('accepts up to 128 chars of [A-Za-z0-9._:-]', () => {
    expect(safeProviderRef('rail-xyz')).toBe('rail-xyz');
    expect(safeProviderRef('simrail-tr_abc:1.2')).toBe('simrail-tr_abc:1.2');
    expect(safeProviderRef('a'.repeat(128))).toBe('a'.repeat(128));
  });
  it('refuses anything else (kept fallback ref)', () => {
    expect(safeProviderRef('<script>' + 'x'.repeat(300))).toBeNull();
    expect(safeProviderRef('a'.repeat(129))).toBeNull();
    expect(safeProviderRef('')).toBeNull();
    expect(safeProviderRef('has space')).toBeNull();
    expect(safeProviderRef(42)).toBeNull();
    expect(safeProviderRef(null)).toBeNull();
  });
});
