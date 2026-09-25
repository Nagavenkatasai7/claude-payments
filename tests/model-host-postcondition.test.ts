import { describe, it, expect } from 'vitest';
import { domainToASCII } from 'node:url';
import { sanitizeReply } from '@/lib/agent';
import { IANA_TLDS } from '@/lib/iana-tlds';
import { canonicalModelToken, hasModelHost, stripModelHosts } from '@/lib/untrusted-text';

// R6b final round: a POSTCONDITION on the text we actually send, checked by an
// oracle that shares no code with the stripper. The oracle deletes invisible
// characters (what a renderer would not show), NFKC-folds, then runs node:url
// domainToASCII (UTS46) over every dotted substring bounded by non-letters /
// non-digits, and flags any that maps to a host whose LAST label is a real
// ASCII IANA TLD. The only allowed survivor is a token that is exactly the
// allowed bare host.

const ALLOWED = 'smartremit.ai';
const LINK = 'https://smartremit.ai/pay/abc123';
const ASCII_TLDS = new Set(IANA_TLDS.filter((t) => /^[a-z0-9-]+$/.test(t)));
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/gu;
const WORDISH = /[\p{L}\p{N}]/u;

function isAllowedToken(token: string): boolean {
  const core = token
    .toLowerCase()
    .replace(/^[(<[{"'“‘*_~`]+/u, '')
    .replace(/[.,!?;:'"”’…)\]}>*_~`]+$/u, '')
    .replace(/^www\./u, '');
  return core === ALLOWED;
}

/** Tokens of `text` that name a real-TLD host (per the oracle) and are not the exact allowed host. */
function oracleOffenders(text: string): string[] {
  const bad: string[] = [];
  for (const token of text.split(/[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u)) {
    if (!token || isAllowedToken(token)) continue;
    const chars = [...token.replace(INVISIBLE, '').normalize('NFKC')];
    if (!chars.includes('.')) continue;
    const n = chars.length;
    let flagged = false;
    for (let i = 0; i < n && !flagged; i++) {
      if (i > 0 && WORDISH.test(chars[i - 1]) && WORDISH.test(chars[i])) continue; // start at a boundary
      for (let j = i + 2; j <= Math.min(n, i + 300); j++) {
        if (j < n && WORDISH.test(chars[j - 1]) && WORDISH.test(chars[j])) continue; // end at a boundary
        const sub = chars.slice(i, j).join('');
        if (!sub.includes('.')) continue;
        const ascii = domainToASCII(sub);
        const last = ascii.split('.').pop() ?? '';
        if (ascii.includes('.') && ASCII_TLDS.has(last)) {
          flagged = true;
          break;
        }
      }
    }
    if (flagged) bad.push(token);
  }
  return bad;
}

function send(fragment: string): string {
  const sent = sanitizeReply(`Hi ${fragment} there`, [LINK], [ALLOWED]);
  // The code-appended link is present byte-for-byte, last.
  expect(sent.endsWith(`\n\n${LINK}`)).toBe(true);
  return sent.slice(0, -LINK.length);
}

// ── generator dimensions ─────────────────────────────────────────────────────
const TLDS = ['online', 'shop', 'com', 'bank', 'ai', 'in', 'co', 'top', 'live', 'xn--p1ai', 'рф', 'भारत'];
const IGNORABLES = ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u00ad', '\u034f', '\ufe0f', '\u180b', '\u3164', '\u115f', '\u202e', '\u0001', '\u061c'];
const DOTS = ['.', '。', '．', '｡', '․', '﹒', '[.]', '(.)', '{.}', '..'];
const COMPAT_HOSTS = [
  'PAY.ONLINE', 'ｐａｙ．ｏｎｌｉｎｅ', 'pay.ſhop', 'pay.\u212aim', 'pay.𝐨𝐧𝐥𝐢𝐧𝐞', 'pay.ⓞⓝⓛⓘⓝⓔ', 'pay⒈online', 'Pay.Online',
];
const SUFFIXES = ['', '/path', '?q=1', '#f', ':8080', '.', ',', '!', ')', '-x', '_x', '/x?y#z'];
// MEDIUM-8: symbols, emoji and marks glued after the TLD (dim 4b).
const GLUED = [
  String.fromCodePoint(0x1f600), String.fromCodePoint(0x1f449), String.fromCodePoint(0x2705), String.fromCodePoint(0x1f4b0),
  String.fromCodePoint(0xa9), String.fromCodePoint(0xfe0f), String.fromCodePoint(0x1f3fd), String.fromCodePoint(0x2764, 0xfe0f),
  String.fromCodePoint(0x301), '$', '^', String.fromCodePoint(0x1f44d, 0x1f3fd), String.fromCodePoint(0x31, 0xfe0f, 0x20e3),
  String.fromCodePoint(0x20b9), String.fromCodePoint(0x2122),
];
const PREFIXES = ['', 'user@', 'https://', 'hxxp://', 'www.', '123', 'x', 'mr.', '.', 'a_'];
const WRAPS: Array<(h: string) => string> = [
  (h) => h, (h) => `_${h}_`, (h) => `*${h}*`, (h) => `~${h}~`, (h) => `\`${h}\``, (h) => `\`\`\`${h}\`\`\``,
  (h) => `[t](${h})`, (h) => `<${h}>`, (h) => `"${h}"`, (h) => `'${h}'`, (h) => `(${h})`, (h) => `*_${h}_*`, (h) => `[${h}](${ALLOWED})`,
];

describe('R6b final: postcondition — nothing we send names a real-TLD host except the exact allowed host', () => {
  it('dims 1+3+4+5: ignorables × dots × suffixes × prefixes over sample TLDs', () => {
    const offenders: string[] = [];
    for (const tld of TLDS) {
      for (const dot of DOTS) {
        for (const pre of PREFIXES) {
          for (const suf of SUFFIXES) {
            const host = `${pre}pay-now${dot}${tld}${suf}`;
            offenders.push(...oracleOffenders(send(host)).map((t) => JSON.stringify(t)));
          }
        }
        for (const ig of IGNORABLES) {
          for (const host of [`pa${ig}y${dot}${tld}`, `pay${ig}${dot}${tld}`, `pay${dot}${ig}${tld}`, `pay${dot}${tld.slice(0, 1)}${ig}${tld.slice(1)}`, `pay${dot}${tld}${ig}`]) {
            offenders.push(...oracleOffenders(send(host)).map((t) => JSON.stringify(t)));
          }
        }
      }
    }
    expect(offenders.slice(0, 20)).toEqual([]);
  });

  it('dim 4b: emoji, symbols and marks glued after (or into) the TLD', () => {
    const offenders: string[] = [];
    for (const tld of TLDS) {
      for (const g of GLUED) {
        for (const host of [`pay.${tld}${g}`, `pay.${tld}${g}/x`, `Visit pay.${tld}${g}`, `pay.${g}${tld}`, `${g}pay.${tld}`]) {
          offenders.push(...oracleOffenders(send(host)).map((t) => JSON.stringify(t)));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('dim 2: case and compatibility forms', () => {
    const offenders = COMPAT_HOSTS.flatMap((h) => oracleOffenders(send(h)));
    expect(offenders).toEqual([]);
    for (const h of COMPAT_HOSTS) expect(send(h)).toBe('Hi there\n\n');
  });

  it('dim 6: several hosts in one token', () => {
    for (const h of ['evil.online,pay.shop', `${ALLOWED})evil.online`, `evil.online@${ALLOWED}`, `${ALLOWED},${ALLOWED}`, `${ALLOWED}.evil.online`]) {
      expect(oracleOffenders(send(h))).toEqual([]);
      expect(send(h)).toBe('Hi there\n\n');
    }
  });

  it('dim 7: wrappers around a foreign host', () => {
    for (const w of WRAPS) {
      for (const tld of TLDS) {
        const h = w(`evil.${tld}`);
        expect(oracleOffenders(send(h)), h).toEqual([]);
      }
    }
  });

  it('dim 8: the allowed host survives its plain variants; each +1 ignorable strips', () => {
    const variants = [ALLOWED, `www.${ALLOWED}`, 'SmartRemit.AI', `${ALLOWED}.`, `*${ALLOWED}*`, `\`${ALLOWED}\``, `(${ALLOWED})`, `<${ALLOWED}>`, `"${ALLOWED}"`, `_${ALLOWED}_,`];
    for (const v of variants) expect(send(v), v).toBe(`Hi ${v} there\n\n`);
    for (const v of variants) {
      for (const ig of IGNORABLES) {
        for (const at of [1, v.indexOf('.'), v.length - 1]) {
          const bad = v.slice(0, at) + ig + v.slice(at);
          expect(send(bad), JSON.stringify(bad)).toBe('Hi there\n\n');
        }
      }
    }
  });

  it('dim 9: non-TLD address forms still strip (IPv4, www., a scheme)', () => {
    for (const h of ['1.2.3.4', '1.2.3.4/pay', 'www.x', 'hxxp://x', 'scheme://x', 'www.local']) {
      expect(send(h), h).toBe('Hi there\n\n');
    }
  });

  it('dim 10: 4KB+ tokens', () => {
    for (const h of [`${'a'.repeat(5000)}.online`, `${'x.'.repeat(3000)}shop`, `${'a'.repeat(4096)}\u200b.bank/${'p'.repeat(2000)}`]) {
      expect(send(h)).toBe('Hi there\n\n');
    }
  });

  it('dim 11: must-survive text is sent unchanged', () => {
    const texts = [
      'Mom gets ₹4,750.00.Thanks!', '1 USD = 83.25 INR', '₹4,750.00', 'Rs.500 fee', 'Rs. 500', 'e.g. U.S. i.e.',
      'Mr.Sharma, Dr.Rao, St.Louis, Mon.Fri, no.12, Sep.25', 'Transfer TX-8F3K2 and tx_01HZX.Paid',
      'माँ को ₹4,750 भेज दिए गए हैं।', 'ठीक.है', 'Aapka paisa kal tak pahunch jayega, bhai.', 'hai.Aapka', 'Hi Priya.Your',
      'Paid at 10.30am', 'Version 2.0', 'rate 1.5x', '$50.00.Done', 'Thanks ❤\ufe0f', 'Family 👨\u200d👩\u200d👧 all set', 'Done 👍🏽',
    ];
    for (const t of texts) {
      expect(sanitizeReply(t, [LINK], [ALLOWED]), t).toBe(`${t}\n\n${LINK}`);
      expect(oracleOffenders(t), t).toEqual([]);
    }
  });

  it('emoji decision: only dotted tokens are canonicalized, so "❤\ufe0f." loses its variation selector', () => {
    expect(sanitizeReply('Thanks ❤\ufe0f', [], [ALLOWED])).toBe('Thanks ❤\ufe0f');
    expect(sanitizeReply('Thanks ❤\ufe0f.', [], [ALLOWED])).toBe('Thanks ❤.');
  });

  it('dotted tokens are sent canonical: invisibles deleted, dot lookalikes folded', () => {
    expect(sanitizeReply('Rs\u200b.500 and 12。30', [], [ALLOWED])).toBe('Rs.500 and 12.30');
  });
});

describe('R6b final: dot lookalikes are complete over all of Unicode', () => {
  it('every code point whose NFKC form contains "." makes its token dotted (canonicalized) and a host before a TLD', () => {
    const zwsp = String.fromCharCode(0x200b);
    const misses: string[] = [];
    for (let cp = 0x80; cp < 0x110000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (!ch.normalize('NFKC').includes('.')) continue;
      if (canonicalModelToken(`a${zwsp}${ch}b`).includes(zwsp)) misses.push(`canon U+${cp.toString(16)}`);
      if (!hasModelHost(`pay${ch}online`)) misses.push(`host U+${cp.toString(16)}`);
    }
    expect(misses).toEqual([]);
  }, 60_000);
});

describe('R6b MEDIUM-8: exhaustive sweep of one code point glued to a host', () => {
  it('for every code point c, no shape pay.online<c> / pay.<c>online / pay<c>.online / <c>pay.online leaves an oracle offender', () => {
    const misses: string[] = [];
    for (let cp = 0; cp < 0x110000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      for (const tok of [`pay.online${c}`, `pay.${c}online`, `pay${c}.online`, `${c}pay.online`]) {
        const out = stripModelHosts(`Hi ${tok} there`, [ALLOWED]);
        if (out.includes('.') && oracleOffenders(out).length > 0) misses.push(`U+${cp.toString(16)} ${JSON.stringify(tok)}`);
      }
      if (misses.length > 20) break;
    }
    expect(misses).toEqual([]);
  }, 300_000);
});
