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
// PR C: fetchOfacSdn is called only by the daily list loader (list-loader.ts),
// which runs from /api/cron ONLY when SANCTIONS_LOADER_ENABLED is set (unset in
// prod), and the screener reads the loaded list only when SANCTIONS_LIST=ofac-sdn
// is set (also unset in prod).

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
    .map((e) =>
      JSON.stringify(
        e.weakNames && e.weakNames.length > 0
          ? [e.id, e.type, [...e.programs].sort(), e.names, e.weakNames]
          : [e.id, e.type, [...e.programs].sort(), e.names],
      ),
    )
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
    const weak: string[] = [];
    const akaList = /<akaList>([\s\S]*?)<\/akaList>/.exec(block)?.[1] ?? '';
    for (const a of akaList.matchAll(/<aka>([\s\S]*?)<\/aka>/g)) {
      const n = personName(a[1]);
      if (!n) continue;
      // PR C: a weak a.k.a. is kept apart — review, never an automatic block.
      if ((tag(a[1], 'category') ?? '').toLowerCase() === 'weak') weak.push(n);
      else akas.push(n);
    }
    const programList = /<programList>([\s\S]*?)<\/programList>/.exec(block)?.[1] ?? '';
    const entry: SanctionsListEntry = {
      id: `sdn:${uid}`,
      names: [primary, ...akas],
      type: tag(own, 'sdnType') ?? 'Unknown',
      programs: tags(programList, 'program'),
    };
    if (weak.length > 0) entry.weakNames = weak;
    entries.push(entry);
  }
  if (entries.length === 0) throw new Error('OFAC SDN: no entries parsed');
  return { source: 'ofac-sdn', version, hash: hashEntries(entries), entries };
}

/** The live SDN.XML is ~30 MB (2026); anything past this is not the list. */
export const OFAC_SDN_MAX_BYTES = 150 * 1024 * 1024;
/** A hung download must not eat the cron's 300 s budget. */
export const OFAC_SDN_FETCH_TIMEOUT_MS = 120_000;

/**
 * Download and parse the live SDN list. Called ONLY by the daily list loader
 * (src/lib/sanctions/list-loader.ts, OFF unless SANCTIONS_LOADER_ENABLED) —
 * nothing in the request path calls it. Bounded: an abort signal and a size
 * cap (declared Content-Length and the actual body).
 */
export async function fetchOfacSdn(
  fetchImpl: typeof fetch = fetch,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<SanctionsList> {
  const maxBytes = opts.maxBytes ?? OFAC_SDN_MAX_BYTES;
  const res = await fetchImpl(OFAC_SDN_XML_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? OFAC_SDN_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OFAC SDN fetch failed: HTTP ${res.status}`);
  const declared = Number(res.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('OFAC SDN fetch failed: body too large');
  const body = await res.text();
  if (body.length > maxBytes) throw new Error('OFAC SDN fetch failed: body too large');
  return parseOfacSdnXml(body);
}
