// OFAC SDN list loader (Program-Fix 14 step 7).
//
// Parses the legacy-schema SDN.XML that Treasury's Sanctions List Service
// publishes (https://ofac.treasury.gov/sanctions-list-service). Verified
// 2026-09-23 against the live export: the URL below answers 302 to a signed
// S3 URL, the root is <sdnList> with <publshInformation><Publish_Date>MM/DD/YYYY,
// and each <sdnEntry> carries <uid>, optional <firstName>, <lastName>,
// <sdnType>, <programList><program>, and <akaList><aka> (lastName/firstName).
// SLS rejects requests without a User-Agent (403, OFAC technical notice
// 2024-05-16), so fetchOfacSdn always sends one.
//
// NOT wired to production: fetchOfacSdn is called only by the snapshot script
// (scripts/sanctions/build-ofac-snapshot.mjs), and the screener reads a
// snapshot only when SANCTIONS_LIST=ofac-sdn is set (it is unset in prod).

import { createHash } from 'node:crypto';
import type { SanctionsList, SanctionsListEntry } from './list-source';

export const OFAC_SDN_XML_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';
const USER_AGENT = 'SmartRemit-sanctions-loader/1.0 (+https://smartremit.ai)';

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decodeEntities(m[1].trim()) : undefined;
}

function tags(block: string, name: string): string[] {
  const out: string[] = [];
  for (const m of block.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))) {
    out.push(decodeEntities(m[1].trim()));
  }
  return out;
}

function personName(block: string): string | undefined {
  const parts = [tag(block, 'firstName'), tag(block, 'lastName')].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Every nested *List block (akaList, idList, addressList, …) removed, so the
 *  entry's OWN uid / names are the only ones left at the top level. */
function stripNestedLists(entry: string): string {
  return entry.replace(/<(\w+List)>[\s\S]*?<\/\1>/g, '').replace(/<vesselInfo>[\s\S]*?<\/vesselInfo>/g, '');
}

function toIsoDate(publishDate: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(publishDate.trim());
  if (!m) throw new Error('OFAC SDN: unrecognised Publish_Date');
  return `${m[3]}-${m[1]}-${m[2]}`;
}

/** sha256 over the canonical entries — insensitive to XML layout, sensitive to content. */
export function hashEntries(entries: SanctionsListEntry[]): string {
  const canonical = entries
    .map((e) => JSON.stringify([e.id, e.type, [...e.programs].sort(), e.names]))
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Pure parser. Throws on a document without a publish date or without entries. */
export function parseOfacSdnXml(xml: string): SanctionsList {
  const publishDate = tag(xml, 'Publish_Date');
  if (!publishDate) throw new Error('OFAC SDN: missing Publish_Date');
  const version = toIsoDate(publishDate);

  const entries: SanctionsListEntry[] = [];
  for (const m of xml.matchAll(/<sdnEntry>([\s\S]*?)<\/sdnEntry>/g)) {
    const block = m[1];
    const own = stripNestedLists(block);
    const uid = tag(own, 'uid');
    const primary = personName(own);
    if (!uid || !primary) continue;
    const akas: string[] = [];
    const akaList = /<akaList>([\s\S]*?)<\/akaList>/.exec(block)?.[1] ?? '';
    for (const a of akaList.matchAll(/<aka>([\s\S]*?)<\/aka>/g)) {
      const n = personName(a[1]);
      if (n) akas.push(n);
    }
    const programList = /<programList>([\s\S]*?)<\/programList>/.exec(block)?.[1] ?? '';
    entries.push({
      id: `sdn:${uid}`,
      names: [primary, ...akas],
      type: tag(own, 'sdnType') ?? 'Unknown',
      programs: tags(programList, 'program'),
    });
  }
  if (entries.length === 0) throw new Error('OFAC SDN: no entries parsed');
  return { source: 'ofac-sdn', version, hash: hashEntries(entries), entries };
}

/**
 * Download and parse the live SDN list. Used ONLY by the snapshot script;
 * nothing in the request path calls it.
 */
export async function fetchOfacSdn(fetchImpl: typeof fetch = fetch): Promise<SanctionsList> {
  const res = await fetchImpl(OFAC_SDN_XML_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`OFAC SDN fetch failed: HTTP ${res.status}`);
  return parseOfacSdnXml(await res.text());
}
