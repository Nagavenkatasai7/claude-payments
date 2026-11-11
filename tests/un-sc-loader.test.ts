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
    vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => body, ...extra }));

  it('constants: the verified by-reference URL, a 300-entry floor, a 20 MB cap, a 60 s timeout', () => {
    expect(UN_SC_XML_URL).toBe('https://scsanctions.un.org/resources/xml/en/consolidated.xml');
    expect(UN_SC_MIN_ENTRIES).toBe(300);
    expect(UN_SC_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(UN_SC_FETCH_TIMEOUT_MS).toBe(60_000);
  });

  it('sends the User-Agent and an abort signal, follows redirects, and parses the body as un-sc', async () => {
    const fetchImpl = ok();
    const list = await fetchUnScList(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(UN_SC_XML_URL);
    expect(new Headers(init.headers).get('user-agent')).toBe('SmartRemit-sanctions-loader/1.0 (+https://smartremit.ai)');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('follow');
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

  it("a body of another structure fails as a parse error ('UN SC:'), never a partial list", async () => {
    const other = FIXTURE.replace('<REFERENCE_NUMBER>YYe.002</REFERENCE_NUMBER>', '');
    await expect(fetchUnScList(ok(other) as unknown as typeof fetch)).rejects.toThrow(/^UN SC: entry 4 has no reference number$/);
  });
});
