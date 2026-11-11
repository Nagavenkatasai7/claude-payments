// Fix pack 5 T26b (R08, P27, orchestrator decision D11): the OFAC consolidated
// (non-SDN) loader. Every name in the fixture is INVENTED; nothing here touches
// the network (fetch is a stub).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseOfacConsolidatedXml,
  fetchOfacConsolidated,
  OFAC_CONS_XML_URL,
  OFAC_CONS_MIN_ENTRIES,
  OFAC_CONS_MAX_BYTES,
  OFAC_CONS_FETCH_TIMEOUT_MS,
} from '@/lib/sanctions/ofac-cons-loader';
import { parseOfacSdnXml } from '@/lib/sanctions/ofac-sdn-loader';

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'ofac-cons-sample.xml'), 'utf8');
const SDN_FIXTURE = readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8');

describe('parseOfacConsolidatedXml (fixture: 4 invented consolidated entries)', () => {
  const list = parseOfacConsolidatedXml(FIXTURE);

  it("parses source 'ofac-cons', version from the publish date, ids 'cons:<uid>' (never 'sdn:')", () => {
    expect(list.source).toBe('ofac-cons');
    expect(list.version).toBe('2026-10-02');
    expect(list.entries.map((e) => e.id)).toEqual(['cons:7101', 'cons:7102', 'cons:7103', 'cons:7104']);
    expect(list.entries.some((e) => e.id.startsWith('sdn:'))).toBe(false);
  });

  it('reads names, AKAs, type and programs; the entry uid, not a nested one', () => {
    const byId = new Map(list.entries.map((e) => [e.id, e]));
    expect(byId.get('cons:7101')!.names).toEqual(['EXAMPLE PETRO TRADING COMPANY', 'EXAMPLE PETRO']);
    expect(byId.get('cons:7103')!.names).toEqual(['Placido INVENTATO', 'Placid INVENTATI']);
    expect(byId.get('cons:7103')!.type).toBe('Individual');
    expect(byId.get('cons:7104')!.names).toEqual(['MOCK & DUMMY CAPITAL BANK']);
    expect(byId.get('cons:7104')!.programs).toEqual(['SAMPLE-MBS', 'SAMPLE-SSI']);
  });

  it('a weak a.k.a. (<category>weak, as in the SDN export) -> weakNames, never a block name', () => {
    const e = list.entries.find((x) => x.id === 'cons:7101')!;
    expect(e.weakNames).toEqual(['EPTC']);
    expect(e.names).not.toContain('EPTC');
    expect(list.entries.find((x) => x.id === 'cons:7102')!.weakNames ?? []).toEqual([]);
  });

  it('the same list parsed twice hashes equal; whitespace-insensitive, content-sensitive', () => {
    expect(list.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseOfacConsolidatedXml(FIXTURE).hash).toBe(list.hash);
    expect(parseOfacConsolidatedXml(FIXTURE.replace(/\n\s*/g, '\n')).hash).toBe(list.hash);
    expect(parseOfacConsolidatedXml(FIXTURE.replace('INVENTATO', 'INVENTATA')).hash).not.toBe(list.hash);
  });

  it("a truncated document, no publish date, no entries -> 'OFAC CONS:' errors", () => {
    const cut = FIXTURE.slice(0, FIXTURE.indexOf('<uid>7103</uid>'));
    expect(() => parseOfacConsolidatedXml(cut)).toThrow(/^OFAC CONS: truncated/);
    expect(() => parseOfacConsolidatedXml(FIXTURE.replace(/<Publish_Date>.*<\/Publish_Date>/, ''))).toThrow(/^OFAC CONS: missing Publish_Date/);
    expect(() => parseOfacConsolidatedXml(FIXTURE.replace('10/02/2026', '2026-10-02'))).toThrow(/^OFAC CONS: unrecognised Publish_Date/);
    expect(() => parseOfacConsolidatedXml(FIXTURE.replace(/<sdnEntry>[\s\S]*<\/sdnEntry>/, ''))).toThrow(/^OFAC CONS: no entries parsed/);
    expect(() => parseOfacConsolidatedXml(FIXTURE.replace('MOCK &amp; DUMMY', 'MOCK &#x110000; DUMMY'))).toThrow(/^OFAC CONS: unparseable/);
  });

  describe('STRICT (D11): a different structure fails loudly, never a partial list', () => {
    it('no <sdnList ...> root start tag -> the whole parse throws', () => {
      const other = FIXTURE.replace(/<sdnList /, '<consolidatedList ').replace('</sdnList>', '</consolidatedList></sdnList>');
      expect(() => parseOfacConsolidatedXml(other)).toThrow(/^OFAC CONS: .*root/);
      // A lookalike root name is not the root either.
      expect(() => parseOfacConsolidatedXml(FIXTURE.replace(/<sdnList /, '<sdnListX '))).toThrow(/^OFAC CONS: .*root/);
    });

    it('no </sdnList> end tag -> throws', () => {
      expect(() => parseOfacConsolidatedXml(FIXTURE.replace('</sdnList>', ''))).toThrow(/^OFAC CONS:/);
    });

    it('an <sdnEntry> with no uid -> the WHOLE parse throws (no silent skip)', () => {
      expect(() => parseOfacConsolidatedXml(FIXTURE.replace('<uid>7102</uid>', ''))).toThrow(/^OFAC CONS: entry 2 has no uid/);
    });

    it('an <sdnEntry> with no primary name (or an empty one) -> the WHOLE parse throws', () => {
      expect(() => parseOfacConsolidatedXml(FIXTURE.replace('<lastName>FICTIONAL MILITARY INDUSTRIES GROUP</lastName>', ''))).toThrow(/^OFAC CONS: entry 2 has no primary name/);
      expect(() => parseOfacConsolidatedXml(FIXTURE.replace('FICTIONAL MILITARY INDUSTRIES GROUP', '   '))).toThrow(/^OFAC CONS: entry 2 has no primary name/);
    });

    it('the error names an entry position only, never a list name', () => {
      try {
        parseOfacConsolidatedXml(FIXTURE.replace('<uid>7103</uid>', ''));
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).not.toMatch(/INVENTAT|Placid/);
      }
    });

    // L1-LF2 (LB1, LE1): an entry element of any other shape fails the WHOLE parse.
    it('an <sdnEntry> with no end tag (it would merge with the next) -> unrecognised entry element', () => {
      const first = FIXTURE.indexOf('</sdnEntry>');
      const merged = FIXTURE.slice(0, first) + FIXTURE.slice(first + '</sdnEntry>'.length);
      expect(() => parseOfacConsolidatedXml(merged)).toThrow(/^OFAC CONS: unrecognised entry element$/);
      // The last entry with no end tag is not a block at all.
      const last = FIXTURE.lastIndexOf('</sdnEntry>');
      const lastOpen = FIXTURE.slice(0, last) + FIXTURE.slice(last + '</sdnEntry>'.length);
      expect(() => parseOfacConsolidatedXml(lastOpen)).toThrow(/^OFAC CONS: unrecognised entry element$/);
    });

    it('an <sdnEntry> with an attribute, a namespace prefix or a spaced end tag -> unrecognised entry element', () => {
      const nth = (xml: string, n: number, from: string, to: string) => {
        let at = -1;
        for (let i = 0; i <= n; i++) at = xml.indexOf(from, at + 1);
        return xml.slice(0, at) + to + xml.slice(at + from.length);
      };
      expect(() => parseOfacConsolidatedXml(nth(FIXTURE, 1, '<sdnEntry>', '<sdnEntry foo="x">'))).toThrow(/^OFAC CONS: unrecognised entry element$/);
      expect(() => parseOfacConsolidatedXml(nth(FIXTURE, 1, '<sdnEntry>', '<sdnEntry xmlns="urn:x">'))).toThrow(/^OFAC CONS: unrecognised entry element$/);
      const prefixed = nth(nth(FIXTURE, 2, '<sdnEntry>', '<o:sdnEntry>'), 2, '</sdnEntry>', '</o:sdnEntry>');
      expect(() => parseOfacConsolidatedXml(prefixed)).toThrow(/^OFAC CONS: unrecognised entry element$/);
      expect(() => parseOfacConsolidatedXml(nth(FIXTURE, 0, '</sdnEntry>', '</sdnEntry >'))).toThrow(/^OFAC CONS: unrecognised entry element$/);
      expect(() => parseOfacConsolidatedXml(nth(FIXTURE, 3, '<sdnEntry>', '<sdnEntry/><sdnEntry>'))).toThrow(/^OFAC CONS: unrecognised entry element$/);
    });

    // L1-LF2 (LB2): a malformed element the parser reads fails the WHOLE parse.
    it('a malformed read element inside an entry (no end tag, attribute, nested) -> the WHOLE parse throws', () => {
      const cases: Array<[string, string, number]> = [
        // An aka with no end tag before the next aka (the second alias would be lost).
        ['<lastName>EXAMPLE PETRO</lastName>\n      </aka>', '<lastName>EXAMPLE PETRO</lastName>\n', 1],
        ['<aka>\n        <uid>8104</uid>', '<aka q="1">\n        <uid>8104</uid>', 3],
        ['<firstName>Placido</firstName>', '<firstName>Placido', 3],
        ['<firstName>Placido</firstName>', '<firstName x="1">Placido</firstName>', 3],
        ['<lastName>INVENTATI</lastName>', '<lastName>INVENTATI', 3],
        ['<lastName>MOCK &amp; DUMMY CAPITAL BANK</lastName>', '<o:lastName>MOCK &amp; DUMMY CAPITAL BANK</o:lastName>', 4],
        ['<uid>7102</uid>', '<uid id="1">7102</uid>', 2],
        ['<sdnType>Entity</sdnType>\n    <programList>\n      <program>SAMPLE-CMIC</program>', '<sdnType>Entity\n    <programList>\n      <program>SAMPLE-CMIC</program>', 2],
        ['<program>SAMPLE-MBS</program>', '<program>SAMPLE-MBS', 4],
        ['<category>weak</category>', '<category kind="x">weak</category>', 1],
        ['<programList>\n      <program>SAMPLE-PLC</program>', '<programList a="1">\n      <program>SAMPLE-PLC</program>', 3],
        ['<akaList>\n      <aka>\n        <uid>8104</uid>', '<akaList x="1">\n      <aka>\n        <uid>8104</uid>', 3],
        // A second akaList (its aliases would be lost) and a name read twice.
        ['</akaList>\n    <dateOfBirthList>', '</akaList>\n    <akaList><aka><lastName>X</lastName></aka></akaList>\n    <dateOfBirthList>', 3],
        ['<lastName>FICTIONAL MILITARY INDUSTRIES GROUP</lastName>', '<lastName>FICTIONAL MILITARY INDUSTRIES GROUP</lastName><lastName>X</lastName>', 2],
        ['<lastName>INVENTATI</lastName>', '<lastName>INVENTATI<b>X</b></lastName>', 3],
      ];
      for (const [from, to, entry] of cases) {
        expect(FIXTURE.includes(from)).toBe(true);
        expect(() => parseOfacConsolidatedXml(FIXTURE.replace(from, to)), to).toThrow(new RegExp(`^OFAC CONS: entry ${entry} has a malformed <`));
      }
    });

    it('a primary name that is only an encoded space is decoded BEFORE the trim -> no primary name', () => {
      expect(() => parseOfacConsolidatedXml(FIXTURE.replace('FICTIONAL MILITARY INDUSTRIES GROUP', '&#32;'))).toThrow(/^OFAC CONS: entry 2 has no primary name$/);
      expect(() => parseOfacConsolidatedXml(FIXTURE.replace('FICTIONAL MILITARY INDUSTRIES GROUP', ' &#x20;&#9; '))).toThrow(/^OFAC CONS: entry 2 has no primary name$/);
      // An alias that is only an encoded space is dropped like an empty one.
      const e = parseOfacConsolidatedXml(FIXTURE.replace('<lastName>EXAMPLE PETRO</lastName>', '<lastName>&#32;</lastName>')).entries[0];
      expect(e.names).toEqual(['EXAMPLE PETRO TRADING COMPANY']);
    });

    it('EMPTY and SELF-CLOSING optional elements stay accepted exactly as before (fixture entry 2)', () => {
      const e = parseOfacConsolidatedXml(FIXTURE).entries.find((x) => x.id === 'cons:7102')!;
      // The fixture gives entry 7102 a self-closing <firstName/>, and an aka with
      // a self-closing <lastName/> and an empty <firstName></firstName>.
      expect(FIXTURE).toMatch(/<uid>7102<\/uid>\s*<firstName\/>/);
      expect(FIXTURE).toMatch(/<lastName\/>\s*<firstName><\/firstName>/);
      expect(e.names).toEqual(['FICTIONAL MILITARY INDUSTRIES GROUP']);
      expect(e.weakNames).toBeUndefined();
      // Self-closing lists are accepted too.
      const selfClosing = FIXTURE.replace(/<programList>\s*<program>SAMPLE-CMIC<\/program>\s*<\/programList>/, '<programList/>');
      expect(parseOfacConsolidatedXml(selfClosing).entries[1].programs).toEqual([]);
    });

    // L1-LF2 (LB3): a repeated uid would drop the second entry in storeList.
    it('a repeated entry uid -> the WHOLE parse throws (position only)', () => {
      expect(() => parseOfacConsolidatedXml(FIXTURE.replace('<uid>7103</uid>', '<uid>7101</uid>'))).toThrow(/^OFAC CONS: entry 3 repeats an id$/);
    });

    // L1-LF2 (LB5): one decoding pass, so an encoded '&' followed by 'lt;' stays '&lt;'.
    it("decodes entities in ONE pass: '&#38;lt;' reads '&lt;', never '<'", () => {
      const e = parseOfacConsolidatedXml(FIXTURE.replace('MOCK &amp; DUMMY', 'MOCK &#38;lt; &#x26;amp; &amp;gt; DUMMY')).entries[3];
      expect(e.names).toEqual(['MOCK &lt; &amp; &gt; DUMMY CAPITAL BANK']);
      expect(parseOfacConsolidatedXml(FIXTURE.replace('MOCK &amp; DUMMY', 'MOCK &quot;&apos;&lt;&gt;&#65;&#x42; DUMMY')).entries[3].names).toEqual([
        'MOCK "\'<>AB DUMMY CAPITAL BANK',
      ]);
    });

    it('a malformed or repeated-id fault never puts a list name in the message', () => {
      for (const v of [
        FIXTURE.replace('<firstName>Placido</firstName>', '<firstName>Placido'),
        FIXTURE.replace('<uid>7103</uid>', '<uid>7101</uid>'),
        FIXTURE.replace('<sdnEntry>', '<sdnEntry foo="x">'),
      ]) {
        try {
          parseOfacConsolidatedXml(v);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toMatch(/^OFAC CONS: /);
          expect((err as Error).message).not.toMatch(/INVENTAT|Placid|EXAMPLE|FICTIONAL|MOCK/);
        }
      }
    });

    it('linear: a ~5 MB strict document parses well inside a generous bound', () => {
      const one = FIXTURE.slice(FIXTURE.indexOf('<sdnEntry>'), FIXTURE.lastIndexOf('</sdnEntry>') + '</sdnEntry>'.length);
      const parts: string[] = [];
      let uid = 100000;
      let size = 0;
      while (size < 5 * 1024 * 1024) {
        const chunk = one.replace(/<uid>710(\d)<\/uid>/g, () => `<uid>${uid++}</uid>`);
        parts.push(chunk);
        size += chunk.length;
      }
      const head = FIXTURE.slice(0, FIXTURE.indexOf('<sdnEntry>'));
      const big = `${head}${parts.join('\n')}\n</sdnList>\n`;
      const t0 = performance.now();
      const list = parseOfacConsolidatedXml(big);
      const ms = performance.now() - t0;
      expect(list.entries.length).toBe(parts.length * 4);
      expect(ms).toBeLessThan(15_000);
    });

    it('the SDN parse is NOT strict: the same faults stay a silent skip there (behaviour unchanged)', () => {
      const noUid = parseOfacSdnXml(SDN_FIXTURE.replace('<uid>1004</uid>', ''));
      expect(noUid.entries.map((e) => e.id)).toEqual(['sdn:1001', 'sdn:1002', 'sdn:1003', 'sdn:1005']);
      const noName = parseOfacSdnXml(SDN_FIXTURE.replace('<lastName>SEA FIXTURE</lastName>', ''));
      expect(noName.entries).toHaveLength(4);
    });
  });
});

describe("the SDN parser's output for the SDN fixture is unchanged (golden, taken before T26b)", () => {
  it('deep-equals its pre-T26b value, hash included', () => {
    expect(parseOfacSdnXml(SDN_FIXTURE)).toEqual({
      source: 'ofac-sdn',
      version: '2026-09-18',
      hash: '9473e6ebe2bf7508457162433e92cbe4b66cb5d5c47c9539857ad642231e7510',
      entries: [
        { id: 'sdn:1001', names: ['EXAMPLE AIRWAYS LTD', 'EXAMPLE-AIR'], type: 'Entity', programs: ['CUBA'] },
        { id: 'sdn:1002', names: ['BANCO EJEMPLO NACIONAL', 'NATIONAL EXAMPLE BANK'], type: 'Entity', programs: ['CUBA'], weakNames: ['BEN'] },
        { id: 'sdn:1003', names: ['Testa FIXTURELLI', 'Sample PLACEHOLDER'], type: 'Individual', programs: ['SDGT'] },
        { id: 'sdn:1004', names: ['SEA FIXTURE'], type: 'Vessel', programs: ['CUBA'] },
        { id: 'sdn:1005', names: ['ALPHA & OMEGA TEST FOUNDATION : SAMPLE BRANCH', 'ALPHA OMEGA TEST FOUNDATION'], type: 'Entity', programs: ['SDGT'] },
      ],
    });
  });

  it('the SDN error prefix is unchanged', () => {
    expect(() => parseOfacSdnXml(SDN_FIXTURE.slice(0, 200))).toThrow(/^OFAC SDN: truncated/);
  });
});

describe('fetchOfacConsolidated (a stub fetch; no network)', () => {
  const ok = (body = FIXTURE, extra: Record<string, unknown> = {}) =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      ...extra,
    }));

  it('constants: the verified SLS URL, a 100-entry floor, a 20 MB cap, a 60 s timeout', () => {
    expect(OFAC_CONS_XML_URL).toBe('https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML');
    expect(OFAC_CONS_MIN_ENTRIES).toBe(100);
    expect(OFAC_CONS_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(OFAC_CONS_FETCH_TIMEOUT_MS).toBe(60_000);
  });

  it('sends the User-Agent and an abort signal, and parses the body as ofac-cons', async () => {
    const fetchImpl = ok();
    const list = await fetchOfacConsolidated(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OFAC_CONS_XML_URL);
    expect(new Headers(init.headers).get('user-agent')).toMatch(/SmartRemit-sanctions-loader/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('manual');
    expect(list.source).toBe('ofac-cons');
    expect(list.entries).toHaveLength(4);
  });

  it('refuses an oversized body (declared or actual)', async () => {
    const declared = ok(FIXTURE, { headers: new Headers({ 'content-length': String(OFAC_CONS_MAX_BYTES + 1) }) });
    await expect(fetchOfacConsolidated(declared as unknown as typeof fetch)).rejects.toThrow(/^OFAC CONS fetch failed: body too large/);
    await expect(fetchOfacConsolidated(ok() as unknown as typeof fetch, { maxBytes: 100 })).rejects.toThrow(/too large/);
  });

  it('throws on a non-2xx response (a fetch error, not a parse error)', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 403, text: async () => '' }));
    const err = await fetchOfacConsolidated(f as unknown as typeof fetch).catch((e: Error) => e);
    expect((err as Error).message).toBe('OFAC CONS fetch failed: HTTP 403');
    expect((err as Error).message.startsWith('OFAC CONS:')).toBe(false);
  });

  it('refuses a redirect off the SLS / us-gov-west-1 S3 hosts', async () => {
    const at = (url: string) => ok(FIXTURE, { url });
    await expect(fetchOfacConsolidated(at('https://evil.example/CONSOLIDATED.XML') as unknown as typeof fetch)).rejects.toThrow(/unexpected host/);
    await expect(fetchOfacConsolidated(at('https://x.s3.us-east-1.amazonaws.com/C.XML') as unknown as typeof fetch)).rejects.toThrow(/unexpected host/);
    await expect(fetchOfacConsolidated(at(OFAC_CONS_XML_URL) as unknown as typeof fetch)).resolves.toMatchObject({ source: 'ofac-cons' });
    await expect(
      fetchOfacConsolidated(at('https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/CONSOLIDATED.XML?X-Amz-Signature=x') as unknown as typeof fetch),
    ).resolves.toMatchObject({ source: 'ofac-cons' });
  });

  // L1-LF3 (LB6): every hop is checked BEFORE it is requested.
  const S3 = 'https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/CONSOLIDATED.XML?X-Amz-Signature=signed';
  const redirectTo = (location: string) => ({ ok: false, status: 302, headers: new Headers({ location }), body: null });
  const routed = (routes: Record<string, unknown>) =>
    vi.fn(async (url: string) => routes[url] ?? { ok: false, status: 404, headers: new Headers(), body: null });

  it('follows the SLS 302 to its us-gov-west-1 S3 download and parses the list', async () => {
    const f = routed({ [OFAC_CONS_XML_URL]: redirectTo(S3), [S3]: await ok()() });
    await expect(fetchOfacConsolidated(f as unknown as typeof fetch)).resolves.toMatchObject({ source: 'ofac-cons' });
    expect(f.mock.calls.map((c) => c[0])).toEqual([OFAC_CONS_XML_URL, S3]);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'https://evil.example/CONSOLIDATED.XML',
    'https://x.s3.us-east-1.amazonaws.com/C.XML',
    'http://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/CONSOLIDATED.XML',
  ])('a redirect to %s fails as a fetch error and is never requested', async (location) => {
    const f = routed({ [OFAC_CONS_XML_URL]: redirectTo(location), [location]: await ok()() });
    const err = await fetchOfacConsolidated(f as unknown as typeof fetch).catch((e: Error) => e);
    expect((err as Error).message).toBe('OFAC CONS fetch failed: unexpected host after redirect');
    expect(f.mock.calls.map((c) => c[0])).toEqual([OFAC_CONS_XML_URL]);
  });

  it('a redirect with no Location, or a fourth hop, fails with the same fetch error', async () => {
    const none = routed({ [OFAC_CONS_XML_URL]: { ok: false, status: 302, headers: new Headers(), body: null } });
    await expect(fetchOfacConsolidated(none as unknown as typeof fetch)).rejects.toThrow(/^OFAC CONS fetch failed: unexpected host after redirect$/);
    const hop = (n: number) => `https://sanctionslistservice.ofac.treas.gov/hop${n}`;
    const loop = routed({
      [OFAC_CONS_XML_URL]: redirectTo(hop(1)),
      [hop(1)]: redirectTo(hop(2)),
      [hop(2)]: redirectTo(hop(3)),
      [hop(3)]: redirectTo(hop(4)),
    });
    await expect(fetchOfacConsolidated(loop as unknown as typeof fetch)).rejects.toThrow(/^OFAC CONS fetch failed: unexpected host after redirect$/);
    expect(loop.mock.calls.map((c) => c[0])).not.toContain(hop(4));
  });

  // L1-LF3 (LB4): the cap is counted in bytes while the body streams.
  it('refuses a streamed body past the cap with no Content-Length, and stops reading it', async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled += 1;
          if (pulled > 1000) c.close();
          else c.enqueue(new Uint8Array(1024).fill(32));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const f = vi.fn(async () => new Response(stream));
    await expect(fetchOfacConsolidated(f as unknown as typeof fetch, { maxBytes: 10 * 1024 })).rejects.toThrow(
      /^OFAC CONS fetch failed: body too large$/,
    );
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
  });

  it('a body of another structure fails as a parse error (OFAC CONS:), never a partial list', async () => {
    const other = FIXTURE.replace('<uid>7104</uid>', '');
    await expect(fetchOfacConsolidated(ok(other) as unknown as typeof fetch)).rejects.toThrow(/^OFAC CONS: entry 4 has no uid/);
  });
});
