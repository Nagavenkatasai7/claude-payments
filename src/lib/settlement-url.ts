// settlement-url — the SYNC rule for where a settlement / reverse instruction
// (decrypted payout destination + recipient legal name on the wire) may be sent,
// and the address classifier the connect-time check applies to every resolved
// address (Program-Fix 22, findings authz-04 / rail-13 / F69).
//
// PURE: no DNS, no network, no env read. The same predicate runs when an admin
// saves the URL (partners/actions.ts), when routing picks a rail
// (partner-rates.ts), when a customer pays (pay/[transferId]/route.ts) and in
// the worker handlers BEFORE fetch (outbox-worker.ts). safe-fetch.ts adds the
// connect-time lookup on top and re-runs this rule on every redirect hop.
//
// Refusals are FIXED reason codes. They ride into outbox.last_error and ops
// alerts, so they must never carry the URL, a host or a response body.

export type SettlementUrlRefusal =
  | 'unparseable'
  | 'scheme'
  | 'userinfo'
  | 'port'
  | 'ip_literal'
  | 'internal_host'
  | 'single_label'
  | 'too_long';

export type SettlementUrlCheck =
  | { ok: true; url: URL; appOrigin: boolean }
  | { ok: false; reason: SettlementUrlRefusal };

export interface SettlementUrlOptions {
  /** The app's own origin (`env.appBaseUrl`). Exact-origin match only. */
  appOrigin: string;
  /** `NODE_ENV === 'production'`. The http app-origin exception exists only when false. */
  production: boolean;
}

/** WHATWG URL parsers accept far longer, but no rail endpoint needs this. */
export const MAX_SETTLEMENT_URL_LENGTH = 2048;

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/**
 * The sync rule. Order matters and is pinned by tests: a private-IP `http://`
 * URL reports `scheme` (the first thing an operator must fix), userinfo is
 * refused BEFORE the app-origin exception (origin equality ignores userinfo),
 * and the app-origin exception is the only path on which `http:` passes.
 */
export function checkSettlementUrl(raw: string, opts: SettlementUrlOptions): SettlementUrlCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'unparseable' };
  if (raw.length > MAX_SETTLEMENT_URL_LENGTH) return { ok: false, reason: 'too_long' };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'unparseable' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'userinfo' };

  // Invariant 5: the app's own origin (simulator rail, worker callback). Over
  // http: it is allowed only outside production (local dev). Over https: it
  // falls through to the normal rule and passes it like any public host.
  if (!opts.production && url.protocol === 'http:' && url.origin === parseOrigin(opts.appOrigin)) {
    return { ok: true, url, appOrigin: true };
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  // WHATWG drops an explicit default port, so anything left is non-default.
  if (url.port !== '') return { ok: false, reason: 'port' };

  const host = url.hostname; // already lower-cased and IPv4-normalised by WHATWG
  if (host === '' ) return { ok: false, reason: 'unparseable' };
  if (host.startsWith('[') || parseIPv4(host) !== null) return { ok: false, reason: 'ip_literal' };
  if (host.endsWith('.')) return { ok: false, reason: 'internal_host' };
  if (host === 'localhost') return { ok: false, reason: 'internal_host' };
  for (const suffix of INTERNAL_SUFFIXES) {
    if (host.endsWith(suffix)) return { ok: false, reason: 'internal_host' };
  }
  const labels = host.split('.');
  if (labels.some((l) => l === '')) return { ok: false, reason: 'unparseable' };
  if (labels.length < 2) return { ok: false, reason: 'single_label' };

  return { ok: true, url, appOrigin: false };
}

function parseOrigin(appOrigin: string): string | null {
  try {
    return new URL(appOrigin).origin;
  } catch {
    return null;
  }
}

/**
 * The rail ack's `providerRef` is stored WRITE-ONCE on the transfer and shown
 * to staff; accept only a short opaque token. Anything else keeps the
 * deterministic `rail-<id>` / `reverse-<id>` fallback.
 */
export function safeProviderRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

// ── Address classes ────────────────────────────────────────────────────────

/** Strict dotted-decimal IPv4 (4 octets, no leading zeros, no shorthand). */
export function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const part = m[i];
    if (part.length > 1 && part.startsWith('0')) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** RFC 4291 text form → 16 bytes. Accepts `::` compression and a dotted IPv4 tail. No zone ids. */
export function parseIPv6(s: string): Uint8Array | null {
  if (s === '' || /[^0-9a-fA-F:.]/.test(s)) return null;
  const dbl = s.indexOf('::');
  if (dbl !== -1 && s.indexOf('::', dbl + 1) !== -1) return null; // only one '::'
  const head = dbl === -1 ? s : s.slice(0, dbl);
  const tail = dbl === -1 ? '' : s.slice(dbl + 2);
  // A dotted quad may only be the LAST group of the whole address: in the tail
  // when '::' is present, at the end of the head when it is not.
  const headWords = groupsToWords(head === '' ? [] : head.split(':'), dbl === -1);
  const tailWords = groupsToWords(tail === '' ? [] : tail.split(':'), true);
  if (headWords === null || tailWords === null) return null;
  const total = headWords.length + tailWords.length;
  if (dbl === -1 ? total !== 8 : total > 7) return null;
  const all = dbl === -1 ? headWords : [...headWords, ...new Array<number>(8 - total).fill(0), ...tailWords];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = all[i] >>> 8;
    out[i * 2 + 1] = all[i] & 0xff;
  }
  return out;
}

function groupsToWords(parts: string[], dottedTailAllowed: boolean): number[] | null {
  const words: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.includes('.')) {
      if (!dottedTailAllowed || i !== parts.length - 1) return null;
      const v4 = parseIPv4(p);
      if (v4 === null) return null;
      words.push(v4 >>> 16, v4 & 0xffff);
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      words.push(parseInt(p, 16));
    }
  }
  return words;
}

function inV4Block(n: number, base: string, bits: number): boolean {
  const b = parseIPv4(base)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((b & mask) >>> 0);
}

/** IPv4 blocks that are never a partner rail: loopback, private, link-local, test nets, multicast, reserved. */
const V4_REFUSED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4], // includes 255.255.255.255
];

function isPublicV4(n: number): boolean {
  return !V4_REFUSED.some(([base, bits]) => inV4Block(n, base, bits));
}

function bytesToV4(b: Uint8Array, offset: number): number {
  return ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0;
}

function prefixIs(b: Uint8Array, prefix: number[]): boolean {
  return prefix.every((v, i) => b[i] === v);
}

/**
 * GLOBAL UNICAST ONLY.
 *  IPv4: everything outside the refused blocks above.
 *  IPv6: `::ffff:0:0/96` (v4-mapped) and `64:ff9b::/96` (well-known NAT64) are
 *  judged by their embedded IPv4. Everything else must sit in 2000::/3 and
 *  outside 2001::/23 (Teredo and friends), 2001:db8::/32, 2002::/16 (6to4,
 *  refused whatever it embeds) and 3fff::/20. So `::`, `::1`, ::/96, fc00::/7,
 *  fe80::/10, ff00::/8 and 64:ff9b:1::/48 are all refused.
 * Anything unparseable is NOT public (fail closed).
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return isPublicV4(v4);
  const b = parseIPv6(ip);
  if (b === null) return false;
  // ::ffff:0:0/96 — v4-mapped
  if (prefixIs(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])) return isPublicV4(bytesToV4(b, 12));
  // 64:ff9b::/96 — well-known NAT64 prefix
  if (prefixIs(b, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) return isPublicV4(bytesToV4(b, 12));
  // 2000::/3
  if ((b[0] & 0xe0) !== 0x20) return false;
  // 2001::/23
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2] & 0xfe) === 0x00) return false;
  // 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false;
  // 2002::/16 — 6to4
  if (b[0] === 0x20 && b[1] === 0x02) return false;
  // 3fff::/20
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0x00) return false;
  return true;
}
