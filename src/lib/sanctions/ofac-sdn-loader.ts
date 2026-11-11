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
import type { SanctionsSourceId } from './list-sets';

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

function toIsoDate(publishDate: string, errorPrefix: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(publishDate.trim());
  if (!m) throw new Error(`${errorPrefix} unrecognised Publish_Date`);
  return `${m[3]}-${m[1]}-${m[2]}`;
}

/**
 * The canonical text of a list: one JSON line per entry, sorted, joined by
 * '\n' (no trailing newline). Fix pack 2 (R07): the Blob archive stores
 * exactly this text, so its sha256 is the version hash.
 */
export function canonicalLines(entries: SanctionsListEntry[]): string {
  return entries
    .map((e) =>
      JSON.stringify(
        e.weakNames && e.weakNames.length > 0
          ? [e.id, e.type, [...e.programs].sort(), e.names, e.weakNames]
          : [e.id, e.type, [...e.programs].sort(), e.names],
      ),
    )
    .sort()
    .join('\n');
}

/** sha256 over the canonical entries — insensitive to XML layout, sensitive to content. */
export function hashEntries(entries: SanctionsListEntry[]): string {
  return createHash('sha256').update(canonicalLines(entries), 'utf8').digest('hex');
}

/**
 * Fix pack 5 T26b: the legacy-XML parse options. One XSD serves SDN.XML and
 * CONSOLIDATED.XML (https://ofac.treasury.gov/recent-actions/20240507_44), so
 * the OFAC consolidated loader (ofac-cons-loader.ts) reuses this parser with
 * its own source, id prefix and error prefix, and `strict: true`. The default
 * is the SDN list exactly as before (every existing caller, the golden test).
 */
export interface SdnXmlParseOptions {
  source: SanctionsSourceId;
  /** Entry ids are `<idPrefix>:<uid>`. */
  idPrefix: string;
  /** Every parse error message starts with this ('OFAC SDN:'). */
  errorPrefix: string;
  /**
   * Strict (ofac-cons, orchestrator decision D11): the document must open with
   * an `<sdnList ...>` root start tag, and EVERY <sdnEntry> must give a uid and
   * a non-empty primary name, else the WHOLE parse throws (no silent skip).
   * Off for SDN: its behaviour is unchanged.
   */
  strict?: boolean;
}

const SDN_PARSE: SdnXmlParseOptions = { source: 'ofac-sdn', idPrefix: 'sdn', errorPrefix: 'OFAC SDN:' };

/** Pure parser. Throws ('OFAC SDN: …') on a truncated document, or one without a publish date or entries. */
export function parseOfacSdnXml(xml: string, opts: SdnXmlParseOptions = SDN_PARSE): SanctionsList {
  try {
    return parseUnchecked(xml, opts);
  } catch (err) {
    // Every parse failure (incl. a RangeError from a malformed entity) is
    // reported as a parse error, prefixed 'OFAC SDN:' (or opts.errorPrefix).
    if (err instanceof Error && err.message.startsWith(opts.errorPrefix)) throw err;
    throw new Error(`${opts.errorPrefix} unparseable document (${err instanceof Error ? err.name : 'unknown'})`);
  }
}

function parseUnchecked(xml: string, opts: SdnXmlParseOptions): SanctionsList {
  const p = opts.errorPrefix;
  // Strict: the root element OFAC published for both files is <sdnList ...>.
  if (opts.strict && !/<sdnList[\s>]/.test(xml)) throw new Error(`${p} unexpected document (no <sdnList> root element)`);
  // A body cut off after N whole entries would otherwise parse cleanly.
  if (!/<\/sdnList>\s*$/.test(xml)) throw new Error(`${p} truncated document (no closing </sdnList>)`);
  const publishDate = tag(xml, 'Publish_Date');
  if (!publishDate) throw new Error(`${p} missing Publish_Date`);
  const version = toIsoDate(publishDate, p);

  const entries: SanctionsListEntry[] = [];
  let position = 0;
  for (const m of xml.matchAll(/<sdnEntry>([\s\S]*?)<\/sdnEntry>/g)) {
    position += 1;
    const block = m[1];
    const own = stripNestedLists(block);
    const uid = tag(own, 'uid');
    const primary = personName(own);
    if (opts.strict) {
      // The position only: never a name from the list in an error text.
      if (!uid) throw new Error(`${p} entry ${position} has no uid`);
      if (!primary) throw new Error(`${p} entry ${position} has no primary name`);
    }
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
      id: `${opts.idPrefix}:${uid}`,
      names: [primary, ...akas],
      type: tag(own, 'sdnType') ?? 'Unknown',
      programs: tags(programList, 'program'),
    };
    if (weak.length > 0) entry.weakNames = weak;
    entries.push(entry);
  }
  if (entries.length === 0) throw new Error(`${p} no entries parsed`);
  return { source: opts.source, version, hash: hashEntries(entries), entries };
}

const SLS_HOST = new URL(OFAC_SDN_XML_URL).hostname;

function allowedFinalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname;
    // SLS itself, or its signed S3 download bucket host in us-gov-west-1
    // (observed 2026-09-23: <bucket>.s3.us-gov-west-1.amazonaws.com). Anchored
    // at both ends. If Treasury moves the bucket, the load fails soft (the last
    // good version stays active, one ops alert per day) until this is updated.
    return h === SLS_HOST || /^[a-z0-9][a-z0-9.-]*\.s3\.us-gov-west-1\.amazonaws\.com$/.test(h);
  } catch {
    return false;
  }
}

/** The live SDN.XML is ~30 MB (2026); anything past this is not the list. */
export const OFAC_SDN_MAX_BYTES = 150 * 1024 * 1024;
/** A hung download must not eat the cron's 300 s budget. */
export const OFAC_SDN_FETCH_TIMEOUT_MS = 120_000;

/**
 * Fix pack 5 T26b: one bounded download from the Sanctions List Service,
 * shared by fetchOfacSdn and fetchOfacConsolidated (ofac-cons-loader.ts).
 * Sends the User-Agent (SLS answers 403 without one), an abort signal and a
 * size cap (declared Content-Length and the actual body), and pins the final
 * URL to the SLS host or its us-gov-west-1 S3 bucket. Error texts are
 * `<label> fetch failed: ...` ('OFAC SDN fetch failed: ...' for SDN, as
 * before). Returns the body text; the caller parses it.
 */
export async function fetchSlsExport(
  url: string,
  fetchImpl: typeof fetch,
  opts: { label: string; maxBytes: number; timeoutMs: number },
): Promise<string> {
  const { label, maxBytes } = opts;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`${label} fetch failed: HTTP ${res.status}`);
  // Redirect pinning: SLS answers 302 to a signed S3 download in
  // us-gov-west-1, so the final URL must be https on the SLS host or that S3
  // region — never anything else. (A stub without res.url is a test.)
  if (res.url && !allowedFinalUrl(res.url)) throw new Error(`${label} fetch failed: unexpected host after redirect`);
  const declared = Number(res.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${label} fetch failed: body too large`);
  const body = await res.text();
  if (body.length > maxBytes) throw new Error(`${label} fetch failed: body too large`);
  return body;
}

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
  const body = await fetchSlsExport(OFAC_SDN_XML_URL, fetchImpl, {
    label: 'OFAC SDN',
    maxBytes: opts.maxBytes ?? OFAC_SDN_MAX_BYTES,
    timeoutMs: opts.timeoutMs ?? OFAC_SDN_FETCH_TIMEOUT_MS,
  });
  return parseOfacSdnXml(body);
}
