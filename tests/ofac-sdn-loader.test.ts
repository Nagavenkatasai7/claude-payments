import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOfacSdnXml, fetchOfacSdn, OFAC_SDN_XML_URL } from '@/lib/sanctions/ofac-sdn-loader';

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'ofac-sdn-sample.xml'), 'utf8');

describe('parseOfacSdnXml (fixture: 5 SDN entries)', () => {
  const list = parseOfacSdnXml(FIXTURE);

  it('reads source, the publish date as version, and every entry', () => {
    expect(list.source).toBe('ofac-sdn');
    expect(list.version).toBe('2026-09-18');
    expect(list.entries.map((e) => e.id)).toEqual(['sdn:1001', 'sdn:1002', 'sdn:1003', 'sdn:1004', 'sdn:1005']);
  });

  it('takes the entry uid, not a nested aka/address/id uid', () => {
    expect(list.entries[0].id).toBe('sdn:1001'); // the aka uid 9001 and address uid 9002 come later in the block
  });

  it('collects primary names and AKAs (individuals as "first last")', () => {
    const byId = new Map(list.entries.map((e) => [e.id, e]));
    expect(byId.get('sdn:1001')!.names).toEqual(['EXAMPLE AIRWAYS LTD', 'EXAMPLE-AIR']);
    // PR C: a WEAK a.k.a. is kept apart (weakNames) — it is screened for review, never a block.
    expect(byId.get('sdn:1002')!.names).toEqual(['BANCO EJEMPLO NACIONAL', 'NATIONAL EXAMPLE BANK']);
    expect(byId.get('sdn:1002')!.weakNames).toEqual(['BEN']);
    expect(byId.get('sdn:1001')!.weakNames ?? []).toEqual([]);
    expect(byId.get('sdn:1003')!.names).toEqual(['Testa FIXTURELLI', 'Sample PLACEHOLDER']);
    expect(byId.get('sdn:1004')!.names).toEqual(['SEA FIXTURE']);
  });

  it('decodes XML entities', () => {
    const e = list.entries.find((x) => x.id === 'sdn:1005')!;
    expect(e.names[0]).toBe('ALPHA & OMEGA TEST FOUNDATION : SAMPLE BRANCH');
  });

  it('reads the entity type and programs', () => {
    const t = Object.fromEntries(list.entries.map((e) => [e.id, [e.type, e.programs]]));
    expect(t['sdn:1001']).toEqual(['Entity', ['CUBA']]);
    expect(t['sdn:1003']).toEqual(['Individual', ['SDGT']]);
    expect(t['sdn:1004']).toEqual(['Vessel', ['CUBA']]);
  });

  it('has a stable content hash (whitespace-insensitive, content-sensitive)', () => {
    expect(list.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseOfacSdnXml(FIXTURE).hash).toBe(list.hash);
    expect(parseOfacSdnXml(FIXTURE.replace(/\n\s*/g, '\n')).hash).toBe(list.hash);
    expect(parseOfacSdnXml(FIXTURE.replace('SEA FIXTURE', 'SEA FIXTURES')).hash).not.toBe(list.hash);
    // A weak a.k.a. that turns strong is a content change too.
    expect(parseOfacSdnXml(FIXTURE.replace('<category>weak</category>', '<category>strong</category>')).hash).not.toBe(list.hash);
  });

  it('refuses a document with no publish date or no entries (never an empty "clean" list)', () => {
    expect(() => parseOfacSdnXml('<sdnList></sdnList>')).toThrow();
    expect(() => parseOfacSdnXml(FIXTURE.replace(/<Publish_Date>.*<\/Publish_Date>/, ''))).toThrow();
    expect(() => parseOfacSdnXml(FIXTURE.replace(/<sdnEntry>[\s\S]*<\/sdnEntry>/, ''))).toThrow();
  });

  it('refuses a truncated document (no closing </sdnList>) even when whole entries parsed', () => {
    const cut = FIXTURE.slice(0, FIXTURE.indexOf('<uid>1003</uid>'));
    expect(() => parseOfacSdnXml(cut)).toThrow(/OFAC SDN:/);
  });

  it('a malformed numeric entity is a parse error (OFAC SDN:), not a crash', () => {
    expect(() => parseOfacSdnXml(FIXTURE.replace('SEA FIXTURE', 'SEA &#x110000; FIXTURE'))).toThrow(/OFAC SDN:/);
  });
});

describe('fetchOfacSdn (never called in prod unless SANCTIONS_LIST is set; here with a stub)', () => {
  it('sends a User-Agent (SLS answers 403 without one) and parses the body', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => FIXTURE }));
    const list = await fetchOfacSdn(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OFAC_SDN_XML_URL);
    expect(new Headers(init.headers).get('user-agent')).toMatch(/\S/);
    expect(list.entries).toHaveLength(5);
  });

  it('passes an abort signal (a hung download cannot eat the cron budget)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => FIXTURE }));
    await fetchOfacSdn(fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses an oversized body (declared or actual) before parsing it', async () => {
    const declared = vi.fn(async () => ({
      ok: true, status: 200, headers: new Headers({ 'content-length': String(500 * 1024 * 1024) }), text: async () => FIXTURE,
    }));
    await expect(fetchOfacSdn(declared as unknown as typeof fetch)).rejects.toThrow(/too large/);
    const actual = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => FIXTURE }));
    await expect(fetchOfacSdn(actual as unknown as typeof fetch, { maxBytes: 100 })).rejects.toThrow(/too large/);
  });

  it('refuses a download that was redirected off the Sanctions List Service host', async () => {
    const res = (url: string) => vi.fn(async () => ({ ok: true, status: 200, url, headers: new Headers(), text: async () => FIXTURE }));
    await expect(fetchOfacSdn(res('https://evil.example/SDN.XML') as unknown as typeof fetch)).rejects.toThrow(/unexpected host/);
    await expect(fetchOfacSdn(res('http://sanctionslistservice.ofac.treas.gov/x') as unknown as typeof fetch)).rejects.toThrow(/unexpected host/);
    await expect(fetchOfacSdn(res(OFAC_SDN_XML_URL) as unknown as typeof fetch)).resolves.toMatchObject({ source: 'ofac-sdn' });
    // SLS 302s to a signed S3 download in us-gov-west-1 (observed by review r2).
    await expect(fetchOfacSdn(res('https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/SDN.XML?X-Amz-Signature=x') as unknown as typeof fetch)).resolves.toMatchObject({ source: 'ofac-sdn' });
    // Any other region's bucket, or a lookalike suffix, is refused.
    await expect(fetchOfacSdn(res('https://x.s3.us-east-1.amazonaws.com/SDN.XML') as unknown as typeof fetch)).rejects.toThrow(/unexpected host/);
    await expect(fetchOfacSdn(res('https://x.s3.amazonaws.com/SDN.XML') as unknown as typeof fetch)).rejects.toThrow(/unexpected host/);
    await expect(fetchOfacSdn(res('https://x.s3.us-gov-west-1.amazonaws.com.evil.example/SDN.XML') as unknown as typeof fetch)).rejects.toThrow(/unexpected host/);
    await expect(fetchOfacSdn(res('https://amazonaws.com.evil.example/SDN.XML') as unknown as typeof fetch)).rejects.toThrow(/unexpected host/);
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, text: async () => '' }));
    await expect(fetchOfacSdn(fetchImpl as unknown as typeof fetch)).rejects.toThrow(/403/);
  });
});
