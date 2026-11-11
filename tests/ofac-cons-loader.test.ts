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
    vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => body, ...extra }));

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

  it('a body of another structure fails as a parse error (OFAC CONS:), never a partial list', async () => {
    const other = FIXTURE.replace('<uid>7104</uid>', '');
    await expect(fetchOfacConsolidated(ok(other) as unknown as typeof fetch)).rejects.toThrow(/^OFAC CONS: entry 4 has no uid/);
  });
});
