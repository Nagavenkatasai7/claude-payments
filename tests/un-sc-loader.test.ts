// Fix pack 5 T27 (R08, P27): the UN Security Council Consolidated List loader.
// Every name in the fixture is INVENTED; nothing here touches the network
// (fetch is a stub).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseUnScXml,
  fetchUnScList,
  UN_SC_XML_URL,
  UN_SC_MIN_ENTRIES,
  UN_SC_MAX_BYTES,
  UN_SC_FETCH_TIMEOUT_MS,
} from '@/lib/sanctions/un-sc-loader';
import { hashEntries } from '@/lib/sanctions/ofac-sdn-loader';

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'un-sc-sample.xml'), 'utf8');
const FIXTURE_NAMES = /ZEPHYRIN|MOCKOVANI|Zeph|ODALRIC|PLACEHOLD|FICTAVIO|TESTARIS|Odo\b|FICTIVE|FHS GROUP|MOCK &|SAMPLE TRADING/;

function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a throw');
}

describe('parseUnScXml (fixture: 2 invented individuals + 2 invented entities)', () => {
  const list = parseUnScXml(FIXTURE);
  const byId = new Map(list.entries.map((e) => [e.id, e]));

  it("parses source 'un-sc', version = the dateGenerated day, ids 'unsc:<reference number>'", () => {
    expect(list.source).toBe('un-sc');
    expect(list.version).toBe('2026-10-04');
    expect(list.entries.map((e) => e.id)).toEqual(['unsc:XXi.001', 'unsc:YYi.002', 'unsc:XXe.001', 'unsc:YYe.002']);
    expect(list.entries.some((e) => /^(sdn|cons):/.test(e.id))).toBe(false);
  });

  it("an individual's name joins FIRST..FOURTH_NAME in order, skipping empty and 'na' parts; type Individual", () => {
    expect(byId.get('unsc:XXi.001')!.names[0]).toBe('ZEPHYRIN MOCKOVANI');
    expect(byId.get('unsc:YYi.002')!.names[0]).toBe('ODALRIC PLACEHOLD FICTAVIO TESTARIS');
    expect(byId.get('unsc:XXi.001')!.type).toBe('Individual');
  });

  it("an entity's name is its FIRST_NAME (entities decoded); type Entity", () => {
    expect(byId.get('unsc:XXe.001')!.names[0]).toBe('FICTIVE HARBOUR SYNDICATE');
    expect(byId.get('unsc:YYe.002')!.names).toEqual(['MOCK & SAMPLE TRADING']);
    expect(byId.get('unsc:YYe.002')!.type).toBe('Entity');
  });

  it('a Good quality alias -> names; a Low quality alias -> weakNames (never names)', () => {
    const z = byId.get('unsc:XXi.001')!;
    expect(z.names).toEqual(['ZEPHYRIN MOCKOVANI', 'Zeph MOCKOVANI']);
    expect(z.weakNames).toEqual(['Zephy']);
    const o = byId.get('unsc:YYi.002')!;
    expect(o.weakNames).toEqual(['Odo']);
    expect(o.names).not.toContain('Odo');
  });

  it('an entity a.k.a. and f.k.a. -> names', () => {
    expect(byId.get('unsc:XXe.001')!.names).toEqual(['FICTIVE HARBOUR SYNDICATE', 'FHS GROUP', 'OLD FICTIVE DOCKS']);
    expect(byId.get('unsc:XXe.001')!.weakNames).toBeUndefined();
  });

  it("an empty alias or 'na' is dropped", () => {
    expect(byId.get('unsc:YYi.002')!.names).toEqual(['ODALRIC PLACEHOLD FICTAVIO TESTARIS']);
    expect(byId.get('unsc:YYe.002')!.weakNames).toBeUndefined();
  });

  it('an alias with an empty or unknown QUALITY is a block name (fail closed), only Low is weak', () => {
    const x = FIXTURE.replace('<QUALITY>Low</QUALITY>\n        <ALIAS_NAME>Zephy', '<QUALITY/>\n        <ALIAS_NAME>Zephy');
    const z = parseUnScXml(x).entries.find((e) => e.id === 'unsc:XXi.001')!;
    expect(z.names).toContain('Zephy');
    expect(z.weakNames).toBeUndefined();
    const lower = FIXTURE.replace('<QUALITY>Low</QUALITY>\n        <ALIAS_NAME>Zephy', '<QUALITY> low </QUALITY>\n        <ALIAS_NAME>Zephy');
    expect(parseUnScXml(lower).entries[0].weakNames).toEqual(['Zephy']);
  });

  it('programs = the UN_LIST_TYPE (the committee regime), never the generic LIST_TYPE value', () => {
    expect(byId.get('unsc:XXi.001')!.programs).toEqual(['Sampleland']);
    expect(byId.get('unsc:YYe.002')!.programs).toEqual(['Exemplaria']);
    expect(list.entries.some((e) => e.programs.includes('UN List'))).toBe(false);
  });

  it('reads the entry own fields, not a nested one (alias CITY_OF_BIRTH, address, document)', () => {
    expect(JSON.stringify(list.entries)).not.toMatch(/Inventedville|X0000000|Passport/);
  });

  it('the same document parsed twice hashes equal; reordering entries keeps the hash', () => {
    expect(list.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(list.hash).toBe(hashEntries(list.entries));
    expect(parseUnScXml(FIXTURE).hash).toBe(list.hash);
    const ents = /<ENTITIES>([\s\S]*)<\/ENTITIES>/.exec(FIXTURE)![1];
    const [a, b] = ents.match(/<ENTITY>[\s\S]*?<\/ENTITY>/g)!;
    const swapped = FIXTURE.replace(ents, `\n    ${b}\n    ${a}\n  `);
    expect(swapped).not.toBe(FIXTURE);
    expect(parseUnScXml(swapped).hash).toBe(list.hash);
    expect(parseUnScXml(FIXTURE.replace('TESTARIS', 'TESTARIX')).hash).not.toBe(list.hash);
  });

  describe("STRICT: every structural fault fails the WHOLE parse with 'UN SC:'", () => {
    it('no <CONSOLIDATED_LIST ...> root start tag -> unexpected document', () => {
      const other = FIXTURE.replace('<CONSOLIDATED_LIST ', '<OTHER_LIST ');
      expect(thrown(() => parseUnScXml(other))).toMatch(/^UN SC: unexpected document/);
      expect(thrown(() => parseUnScXml(FIXTURE.replace('<CONSOLIDATED_LIST ', '<CONSOLIDATED_LISTX ')))).toMatch(/^UN SC: unexpected document/);
    });

    it('no closing root tag -> truncated document', () => {
      expect(thrown(() => parseUnScXml(FIXTURE.replace('</CONSOLIDATED_LIST>', '')))).toMatch(/^UN SC: truncated document/);
      const cut = FIXTURE.slice(0, FIXTURE.indexOf('<REFERENCE_NUMBER>XXe.001'));
      expect(thrown(() => parseUnScXml(cut))).toMatch(/^UN SC: truncated document/);
    });

    it('no dateGenerated -> missing date; a malformed one -> unrecognised', () => {
      expect(thrown(() => parseUnScXml(FIXTURE.replace(/ dateGenerated="[^"]*"/, '')))).toMatch(/^UN SC: missing date/);
      expect(thrown(() => parseUnScXml(FIXTURE.replace('2026-10-04T00:00:03.543Z', '04/10/2026')))).toMatch(/^UN SC: unrecognised dateGenerated/);
    });

    it("a document with no entries -> 'UN SC: no entries parsed'", () => {
      const none = FIXTURE.replace(/<INDIVIDUALS>[\s\S]*<\/INDIVIDUALS>/, '<INDIVIDUALS/>').replace(/<ENTITIES>[\s\S]*<\/ENTITIES>/, '<ENTITIES/>');
      expect(thrown(() => parseUnScXml(none))).toBe('UN SC: no entries parsed');
    });

    it('an entry with no reference number (missing or empty) -> the WHOLE parse throws', () => {
      expect(thrown(() => parseUnScXml(FIXTURE.replace('<REFERENCE_NUMBER>YYi.002</REFERENCE_NUMBER>', '')))).toBe('UN SC: entry 2 has no reference number');
      expect(thrown(() => parseUnScXml(FIXTURE.replace('<REFERENCE_NUMBER>XXe.001</REFERENCE_NUMBER>', '<REFERENCE_NUMBER/>')))).toBe('UN SC: entry 3 has no reference number');
    });

    it('an entry with no name -> the WHOLE parse throws', () => {
      const noEntityName = FIXTURE.replace('<FIRST_NAME>MOCK &amp; SAMPLE TRADING</FIRST_NAME>', '<FIRST_NAME/>');
      expect(thrown(() => parseUnScXml(noEntityName))).toBe('UN SC: entry 4 has no name');
      const naOnly = FIXTURE.replace('<FIRST_NAME>ZEPHYRIN</FIRST_NAME>', '<FIRST_NAME>na</FIRST_NAME>').replace('<SECOND_NAME>MOCKOVANI</SECOND_NAME>', '<SECOND_NAME/>');
      expect(thrown(() => parseUnScXml(naOnly))).toBe('UN SC: entry 1 has no name');
    });

    it('an entry element of an unrecognised shape (e.g. with attributes) -> throws, never a silent skip', () => {
      expect(thrown(() => parseUnScXml(FIXTURE.replace('<ENTITY>', '<ENTITY id="1">')))).toMatch(/^UN SC: unrecognised entry element/);
    });

    // L1-LF2 (LB1): an entry block may not hold another entry opening of either kind.
    it('an ENTITY nested inside an INDIVIDUAL, a prefixed or a spaced-end entry -> unrecognised entry element', () => {
      const ents = /<ENTITY>[\s\S]*?<\/ENTITY>/.exec(FIXTURE)![0];
      const nested = FIXTURE.replace(ents, '').replace('<SORT_KEY_LAST_MOD/>\n    </INDIVIDUAL>\n  </INDIVIDUALS>', `<SORT_KEY_LAST_MOD/>\n${ents}\n    </INDIVIDUAL>\n  </INDIVIDUALS>`);
      expect(nested).not.toBe(FIXTURE);
      expect(thrown(() => parseUnScXml(nested))).toMatch(/^UN SC: unrecognised entry element/);
      const prefixed = FIXTURE.replace(ents, ents.replace('<ENTITY>', '<u:ENTITY>').replace('</ENTITY>', '</u:ENTITY>'));
      expect(thrown(() => parseUnScXml(prefixed))).toMatch(/^UN SC: unrecognised entry element \(entity\)$/);
      expect(thrown(() => parseUnScXml(FIXTURE.replace('</INDIVIDUAL>', '</INDIVIDUAL >')))).toMatch(/^UN SC: unrecognised entry element \(individual\)$/);
    });

    // L1-LF2 (LB2): a malformed element the parser reads fails the WHOLE parse.
    it('a malformed read element inside an entry (no end tag, attribute, prefix, nested) -> the WHOLE parse throws', () => {
      const cases: Array<[string, string, number]> = [
        // An alias with no end tag before the next alias (the second name would be lost).
        ['<ALIAS_NAME>Zeph MOCKOVANI</ALIAS_NAME>\n      </INDIVIDUAL_ALIAS>', '<ALIAS_NAME>Zeph MOCKOVANI</ALIAS_NAME>\n', 1],
        ['<INDIVIDUAL_ALIAS>\n        <QUALITY>Low</QUALITY>\n        <ALIAS_NAME>Odo', '<INDIVIDUAL_ALIAS q="1">\n        <QUALITY>Low</QUALITY>\n        <ALIAS_NAME>Odo', 2],
        ['<ENTITY_ALIAS>\n        <QUALITY>f.k.a.</QUALITY>', '<ENTITY_ALIAS q="1">\n        <QUALITY>f.k.a.</QUALITY>', 3],
        ['<FIRST_NAME>ZEPHYRIN</FIRST_NAME>', '<FIRST_NAME>ZEPHYRIN', 1],
        ['<FIRST_NAME>ZEPHYRIN</FIRST_NAME>', '<FIRST_NAME lang="x">ZEPHYRIN</FIRST_NAME>', 1],
        ['<SECOND_NAME>PLACEHOLD</SECOND_NAME>', '<SECOND_NAME>PLACEHOLD', 2],
        ['<THIRD_NAME>FICTAVIO</THIRD_NAME>', '<u:THIRD_NAME>FICTAVIO</u:THIRD_NAME>', 2],
        ['<FOURTH_NAME>TESTARIS</FOURTH_NAME>', '<FOURTH_NAME>TESTARIS<x/></FOURTH_NAME>', 2],
        ['<REFERENCE_NUMBER>XXe.001</REFERENCE_NUMBER>', '<REFERENCE_NUMBER id="1">XXe.001</REFERENCE_NUMBER>', 3],
        ['<ALIAS_NAME>FHS GROUP</ALIAS_NAME>', '<ALIAS_NAME>FHS GROUP', 3],
        ['<ALIAS_NAME>Zephy</ALIAS_NAME>', '<ALIAS_NAME x="1">Zephy</ALIAS_NAME>', 1],
        ['<QUALITY>Good</QUALITY>\n        <ALIAS_NAME>Zeph', '<QUALITY>Good\n        <ALIAS_NAME>Zeph', 1],
        ['<UN_LIST_TYPE>Exemplaria</UN_LIST_TYPE>\n      <REFERENCE_NUMBER>YYe.002', '<UN_LIST_TYPE a="b">Exemplaria</UN_LIST_TYPE>\n      <REFERENCE_NUMBER>YYe.002', 4],
        // A name part read twice, or two names in one alias.
        ['<FIRST_NAME>ODALRIC</FIRST_NAME>', '<FIRST_NAME>ODALRIC</FIRST_NAME><FIRST_NAME>X</FIRST_NAME>', 2],
        ['<ALIAS_NAME>OLD FICTIVE DOCKS</ALIAS_NAME>', '<ALIAS_NAME>OLD FICTIVE DOCKS</ALIAS_NAME><ALIAS_NAME>X</ALIAS_NAME>', 3],
      ];
      for (const [from, to, entry] of cases) {
        expect(FIXTURE.includes(from), from).toBe(true);
        const msg = thrown(() => parseUnScXml(FIXTURE.replace(from, to)));
        expect(msg, to).toMatch(new RegExp(`^UN SC: entry ${entry} has a malformed <`));
        expect(msg).not.toMatch(FIXTURE_NAMES);
      }
    });

    it('a name that is only an encoded space is decoded BEFORE the trim -> no name', () => {
      expect(thrown(() => parseUnScXml(FIXTURE.replace('MOCK &amp; SAMPLE TRADING', '&#32;')))).toBe('UN SC: entry 4 has no name');
      expect(thrown(() => parseUnScXml(FIXTURE.replace('MOCK &amp; SAMPLE TRADING', ' &#x20;&#9; ')))).toBe('UN SC: entry 4 has no name');
      // An alias that is only an encoded space is dropped like an empty one.
      const e = parseUnScXml(FIXTURE.replace('<ALIAS_NAME>FHS GROUP</ALIAS_NAME>', '<ALIAS_NAME>&#32;</ALIAS_NAME>')).entries[2];
      expect(e.names).toEqual(['FICTIVE HARBOUR SYNDICATE', 'OLD FICTIVE DOCKS']);
    });

    it('EMPTY and SELF-CLOSING optional elements stay accepted exactly as before', () => {
      // The fixture holds a self-closing alias (<QUALITY/>, <ALIAS_NAME/>), a
      // self-closing <THIRD_NAME/>, and an empty alias and name part in entry 2.
      expect(FIXTURE).toMatch(/<QUALITY\/>\s*<ALIAS_NAME\/>/);
      expect(FIXTURE).toMatch(/<QUALITY><\/QUALITY>\s*<ALIAS_NAME><\/ALIAS_NAME>/);
      expect(FIXTURE).toMatch(/<INDIVIDUAL_ALIAS\/>/);
      expect(parseUnScXml(FIXTURE).entries.find((e) => e.id === 'unsc:YYi.002')!.names).toEqual(['ODALRIC PLACEHOLD FICTAVIO TESTARIS']);
      const emptyPart = FIXTURE.replace('<THIRD_NAME/>', '<THIRD_NAME></THIRD_NAME>');
      expect(parseUnScXml(emptyPart).entries[0].names[0]).toBe('ZEPHYRIN MOCKOVANI');
    });

    // L1-LF2 (LB3): a repeated reference number would drop the second entry in storeList.
    it('a repeated REFERENCE_NUMBER -> the WHOLE parse throws (position only)', () => {
      expect(thrown(() => parseUnScXml(FIXTURE.replace('<REFERENCE_NUMBER>YYe.002<', '<REFERENCE_NUMBER>XXi.001<')))).toBe('UN SC: entry 4 repeats an id');
    });

    // L1-LF2 (LB5): one decoding pass, so an encoded '&' followed by 'lt;' stays '&lt;'.
    it("decodes entities in ONE pass: '&#38;lt;' reads '&lt;', never '<'", () => {
      const e = parseUnScXml(FIXTURE.replace('MOCK &amp; SAMPLE', 'MOCK &#38;lt; &#x26;amp; &amp;gt; SAMPLE')).entries[3];
      expect(e.names).toEqual(['MOCK &lt; &amp; &gt; SAMPLE TRADING']);
      const all = parseUnScXml(FIXTURE.replace('MOCK &amp; SAMPLE', 'MOCK &quot;&apos;&lt;&gt;&#65;&#x42; SAMPLE')).entries[3];
      expect(all.names).toEqual(['MOCK "\'<>AB SAMPLE TRADING']);
    });

    it('linear: a ~5 MB document parses well inside a generous bound', () => {
      const inds = /<INDIVIDUALS>([\s\S]*)<\/INDIVIDUALS>/.exec(FIXTURE)![1];
      const parts: string[] = [];
      let ref = 0;
      let size = 0;
      while (size < 5 * 1024 * 1024) {
        const chunk = inds.replace(/<REFERENCE_NUMBER>[^<]*<\/REFERENCE_NUMBER>/g, () => `<REFERENCE_NUMBER>ZZi.${ref++}</REFERENCE_NUMBER>`);
        parts.push(chunk);
        size += chunk.length;
      }
      const big = FIXTURE.replace(inds, parts.join(''));
      const t0 = performance.now();
      const list = parseUnScXml(big);
      const ms = performance.now() - t0;
      expect(list.entries.length).toBe(parts.length * 2 + 2);
      expect(ms).toBeLessThan(15_000);
    });

    it('a malformed character reference -> unparseable document (<ErrorName>)', () => {
      expect(thrown(() => parseUnScXml(FIXTURE.replace('MOCK &amp; SAMPLE', 'MOCK &#x110000; SAMPLE')))).toBe('UN SC: unparseable document (RangeError)');
    });

    it('no name from the fixture appears in any thrown message', () => {
      const variants = [
        FIXTURE.replace('</CONSOLIDATED_LIST>', ''),
        FIXTURE.replace(/ dateGenerated="[^"]*"/, ''),
        FIXTURE.replace('<REFERENCE_NUMBER>YYi.002</REFERENCE_NUMBER>', ''),
        FIXTURE.replace('<FIRST_NAME>MOCK &amp; SAMPLE TRADING</FIRST_NAME>', '<FIRST_NAME/>'),
        FIXTURE.replace('<ENTITY>', '<ENTITY id="1">'),
        FIXTURE.replace('MOCK &amp; SAMPLE', 'MOCK &#x110000; SAMPLE'),
      ];
      for (const v of variants) {
        const msg = thrown(() => parseUnScXml(v));
        expect(msg.startsWith('UN SC:')).toBe(true);
        expect(msg).not.toMatch(FIXTURE_NAMES);
      }
    });
  });
});

describe('fetchUnScList (a stub fetch; no network)', () => {
  const ok = (body = FIXTURE, extra: Record<string, unknown> = {}) =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      ...extra,
    }));

  it('constants: the verified by-reference URL, a 300-entry floor, a 20 MB cap, a 60 s timeout', () => {
    expect(UN_SC_XML_URL).toBe('https://scsanctions.un.org/resources/xml/en/consolidated.xml');
    expect(UN_SC_MIN_ENTRIES).toBe(300);
    expect(UN_SC_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(UN_SC_FETCH_TIMEOUT_MS).toBe(60_000);
  });

  it('sends the User-Agent and an abort signal, follows redirects by hand, and parses the body as un-sc', async () => {
    const fetchImpl = ok();
    const list = await fetchUnScList(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(UN_SC_XML_URL);
    expect(new Headers(init.headers).get('user-agent')).toBe('SmartRemit-sanctions-loader/1.0 (+https://smartremit.ai)');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('manual');
    expect(list.source).toBe('un-sc');
    expect(list.entries).toHaveLength(4);
  });

  it('throws on a non-2xx response (a fetch error, not a parse error)', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 503, text: async () => '' }));
    const msg = await fetchUnScList(f as unknown as typeof fetch).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(msg).toBe('UN SC fetch failed: HTTP 503');
    expect(msg.startsWith('UN SC:')).toBe(false);
  });

  it('refuses an oversized body (declared or actual)', async () => {
    const declared = ok(FIXTURE, { headers: new Headers({ 'content-length': String(UN_SC_MAX_BYTES + 1) }) });
    await expect(fetchUnScList(declared as unknown as typeof fetch)).rejects.toThrow(/^UN SC fetch failed: body too large$/);
    await expect(fetchUnScList(ok() as unknown as typeof fetch, { maxBytes: 100 })).rejects.toThrow(/^UN SC fetch failed: body too large$/);
  });

  it('pins the final URL to exactly the two verified https hosts', async () => {
    const at = (url: string) => fetchUnScList(ok(FIXTURE, { url }) as unknown as typeof fetch);
    for (const bad of [
      'https://scsanctions.un.org.evil.example/consolidated.xml',
      'http://unsolprodfiles.blob.core.windows.net/publiclegacyxmlfiles/EN/consolidatedLegacyByPRN.xml',
      'https://other.blob.core.windows.net/publiclegacyxmlfiles/EN/consolidatedLegacyByPRN.xml',
      'http://scsanctions.un.org/resources/xml/en/consolidated.xml',
      'https://evil.example/consolidated.xml',
      'not a url',
    ]) {
      await expect(at(bad)).rejects.toThrow(/^UN SC fetch failed: unexpected host after redirect$/);
    }
    await expect(at(UN_SC_XML_URL)).resolves.toMatchObject({ source: 'un-sc' });
    await expect(
      at('https://unsolprodfiles.blob.core.windows.net/publiclegacyxmlfiles/EN/consolidatedLegacyByPRN.xml?se=x&sig=y&sp=r&sr=b'),
    ).resolves.toMatchObject({ source: 'un-sc' });
  });

  it('a stub without res.url is accepted (test seam, as SDN)', async () => {
    await expect(fetchUnScList(ok() as unknown as typeof fetch)).resolves.toMatchObject({ source: 'un-sc' });
  });

  // L1-LF3 (LB6): every hop is checked BEFORE it is requested.
  const BLOB = 'https://unsolprodfiles.blob.core.windows.net/publiclegacyxmlfiles/EN/consolidatedLegacyByPRN.xml?se=x&sig=signed&sp=r&sr=b';
  const redirectTo = (location: string) => ({ ok: false, status: 302, headers: new Headers({ location }), body: null });
  const routed = (routes: Record<string, unknown>) =>
    vi.fn(async (url: string) => routes[url] ?? { ok: false, status: 404, headers: new Headers(), body: null });

  it('follows the verified 302 to the blob host and parses the list', async () => {
    const answer = await ok()();
    const g = routed({ [UN_SC_XML_URL]: redirectTo(BLOB), [BLOB]: answer });
    await expect(fetchUnScList(g as unknown as typeof fetch)).resolves.toMatchObject({ source: 'un-sc' });
    expect(g.mock.calls.map((c) => c[0])).toEqual([UN_SC_XML_URL, BLOB]);
    expect(g.mock.calls.every((c) => (c as unknown as [string, RequestInit])[1].redirect === 'manual')).toBe(true);
  });

  it.each(['http://169.254.169.254/latest/meta-data/', 'https://evil.example/consolidated.xml', 'http://unsolprodfiles.blob.core.windows.net/x.xml'])(
    'a redirect to %s fails as a fetch error and is never requested',
    async (location) => {
      const answer = await ok()();
      const f = routed({ [UN_SC_XML_URL]: redirectTo(location), [location]: answer });
      const msg = await fetchUnScList(f as unknown as typeof fetch).then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      expect(msg).toBe('UN SC fetch failed: unexpected host after redirect');
      expect(f.mock.calls.map((c) => c[0])).toEqual([UN_SC_XML_URL]);
    },
  );

  it('a redirect with no Location, or a fourth hop, fails with the same fetch error', async () => {
    const none = routed({ [UN_SC_XML_URL]: { ok: false, status: 302, headers: new Headers(), body: null } });
    await expect(fetchUnScList(none as unknown as typeof fetch)).rejects.toThrow(/^UN SC fetch failed: unexpected host after redirect$/);
    const hop = (n: number) => `https://scsanctions.un.org/hop${n}`;
    const loop = routed({ [UN_SC_XML_URL]: redirectTo(hop(1)), [hop(1)]: redirectTo(hop(2)), [hop(2)]: redirectTo(hop(3)), [hop(3)]: redirectTo(hop(4)) });
    await expect(fetchUnScList(loop as unknown as typeof fetch)).rejects.toThrow(/^UN SC fetch failed: unexpected host after redirect$/);
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
    await expect(fetchUnScList(f as unknown as typeof fetch, { maxBytes: 10 * 1024 })).rejects.toThrow(/^UN SC fetch failed: body too large$/);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
  });

  it('counts the cap in bytes, not UTF-16 units', async () => {
    // Pad the fixture with 2-byte characters (a comment the parse ignores).
    const padded = FIXTURE.replace('</CONSOLIDATED_LIST>', `<!-- ${'é'.repeat(100)} --></CONSOLIDATED_LIST>`);
    const bytes = new TextEncoder().encode(padded).byteLength;
    const f = () => vi.fn(async () => new Response(padded));
    await expect(fetchUnScList(f() as unknown as typeof fetch, { maxBytes: bytes })).resolves.toMatchObject({ source: 'un-sc' });
    expect(padded.length).toBeLessThan(bytes);
    await expect(fetchUnScList(f() as unknown as typeof fetch, { maxBytes: padded.length })).rejects.toThrow(/^UN SC fetch failed: body too large$/);
  });

  it("a body of another structure fails as a parse error ('UN SC:'), never a partial list", async () => {
    const other = FIXTURE.replace('<REFERENCE_NUMBER>YYe.002</REFERENCE_NUMBER>', '');
    await expect(fetchUnScList(ok(other) as unknown as typeof fetch)).rejects.toThrow(/^UN SC: entry 4 has no reference number$/);
  });
});
