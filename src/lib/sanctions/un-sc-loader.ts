// UN Security Council Consolidated List loader (fix pack 5 T27, R08, P27).
//
// Verified directly on 2026-11-11 (WebFetch / WebSearch, official UN sources only):
// - Download URL: https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list
//   links the XML "By Permanent Reference Number" at
//   https://scsanctions.un.org/resources/xml/en/consolidated.xml (UN_SC_XML_URL;
//   the alphabetical one is .../xml/en/name/consolidated.xml). It answers
//   302 Found to a signed Azure Blob URL on unsolprodfiles.blob.core.windows.net
//   (/publiclegacyxmlfiles/EN/consolidatedLegacyByPRN.xml?...&se=...&sig=...),
//   so the final URL is pinned to exactly those TWO https hosts (no wildcard).
// - The XSD: https://scsanctions.un.org/sc-sanctions.xsd (named by the files'
//   xsi:noNamespaceSchemaLocation; the by-reference file names
//   https://www.un.org/sc/resources/sc-sanctions.xsd, which did not answer).
//   Root <CONSOLIDATED_LIST dateGenerated="..."> (xs:dateTime, seen as
//   2026-11-11T00:00:03.543Z), children <INDIVIDUALS><INDIVIDUAL>... and
//   <ENTITIES><ENTITY>.... INDIVIDUAL: DATAID, VERSIONNUM, FIRST_NAME,
//   SECOND_NAME?, THIRD_NAME?, FOURTH_NAME? (XSD default "na"), UN_LIST_TYPE,
//   REFERENCE_NUMBER (xs:NCName), LISTED_ON, ..., TITLE/DESIGNATION/NATIONALITY/
//   LIST_TYPE/LAST_DAY_UPDATED (each wrapping <VALUE>), INDIVIDUAL_ALIAS
//   (QUALITY, ALIAS_NAME, optional DATE_OF_BIRTH, CITY_OF_BIRTH,
//   COUNTRY_OF_BIRTH, NOTE), INDIVIDUAL_ADDRESS, INDIVIDUAL_DATE_OF_BIRTH,
//   INDIVIDUAL_PLACE_OF_BIRTH, INDIVIDUAL_DOCUMENT, SORT_KEY, SORT_KEY_LAST_MOD.
//   ENTITY: DATAID, VERSIONNUM, FIRST_NAME (the entity name), UN_LIST_TYPE,
//   REFERENCE_NUMBER, ..., LIST_TYPE, ENTITY_ALIAS (QUALITY, ALIAS_NAME, NOTE?),
//   ENTITY_ADDRESS, SORT_KEY, SORT_KEY_LAST_MOD. QUALITY is a plain xs:string.
// - The files themselves (structure only, read through WebFetch):
//   https://unsolprodfiles.blob.core.windows.net/publiclegacyxmlfiles/EN/consolidatedLegacyByPRN.xml
//   (the redirect target; root, INDIVIDUAL fields, QUALITY values "Good" and
//   "Low"), https://scsanctions.un.org/xml/en/haiti (a committee file in the same
//   schema, read to its end: ENTITY fields, ENTITY_ALIAS QUALITY "a.k.a.",
//   empty fields written self-closing such as <QUALITY/> and <ALIAS_NAME/>,
//   the document closes with </CONSOLIDATED_LIST>) and
//   https://scsanctions.un.org/xml/en/iraq (QUALITY "Good", "Low" and empty).
//   UN_LIST_TYPE is the committee regime (e.g. "Haiti"); LIST_TYPE/VALUE is
//   always "UN List", so programs = [UN_LIST_TYPE].
// - Alias quality: the UN page describes "Good quality a.k.a." as "sufficient
//   for a positive identification" and "Low quality a.k.a." as "probably
//   insufficient alone", for individuals; entities list "A.k.a." and "F.k.a."
//   with no quality. So QUALITY "Low" -> weakNames (review, never an automatic
//   block); every other value ("Good", "a.k.a.", "f.k.a.", empty or unknown)
//   -> names (fail closed: an unknown quality blocks rather than passes).
//
// The parse is STRICT (as the OFAC consolidated one): no <CONSOLIDATED_LIST>
// root or no </CONSOLIDATED_LIST> end, no dateGenerated, an entry element of an
// unrecognised shape, an entry without a reference number or a name, or zero
// entries fails the WHOLE parse with 'UN SC: ...' (positions only, never a
// name), so a changed structure never loads a partial list (runListLoad keeps
// the last good version and alerts). Fix pack 5 L1-LF2 adds: an entry block
// holding another entry opening of either kind, or an entry end tag of
// another shape ('unrecognised entry element'); a malformed element the
// parser reads (no end tag, an attribute or namespace prefix, a tag inside a
// text element, an alias opened again before its end tag, a name part given
// twice: 'entry <n> has a malformed <X> element'); a repeated
// REFERENCE_NUMBER ('entry <n> repeats an id'). Empty and self-closing
// optional elements (<ALIAS_NAME/>, <THIRD_NAME></THIRD_NAME>) are accepted.
// Entities are decoded in ONE pass and BEFORE the trim (decodeEntitiesOnce /
// strictTag in ofac-sdn-loader.ts), so a name of only '&#32;' is empty.
//
// Owner step: the first live load on a preview deployment, with a count check
// against the UN page, comes before SANCTIONS_LIST=lists is ever set (the
// build machine cannot download the list itself).
//
// The test fixture (tests/fixtures/un-sc-sample.xml) is hand-built to this
// structure with INVENTED names. No call site in src yet: fix pack 5 T30 wires
// the cron (only with SANCTIONS_LOADER_ENABLED and SANCTIONS_LIST=lists).

import type { SanctionsList, SanctionsListEntry } from './list-source';
import { entryElementsMatch, hashEntries, malformedElement, strictTag as tag } from './ofac-sdn-loader';

export const UN_SC_XML_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';
const USER_AGENT = 'SmartRemit-sanctions-loader/1.0 (+https://smartremit.ai)';
const ERR = 'UN SC:';

/**
 * A conservative floor below the expected ~1,000 entries (assumed, P33 T27):
 * the owner's first live load on a preview confirms the count (index.md owner
 * step). runListLoad refuses a smaller list.
 */
export const UN_SC_MIN_ENTRIES = 300;
/** The legacy XML is a few MB; anything past this is not the list. */
export const UN_SC_MAX_BYTES = 20 * 1024 * 1024;
/** A hung download must not eat the cron's 300 s budget. */
export const UN_SC_FETCH_TIMEOUT_MS = 60_000;

const ENTRY_KINDS = ['INDIVIDUAL', 'ENTITY'] as const;
/** The text elements the parser reads (L1-LF2, LB2). */
const UN_LEAVES = [
  'REFERENCE_NUMBER',
  'FIRST_NAME',
  'SECOND_NAME',
  'THIRD_NAME',
  'FOURTH_NAME',
  'UN_LIST_TYPE',
  'ALIAS_NAME',
  'QUALITY',
] as const;
/** Read once from the entry's own fields: a second one would be dropped. */
const UN_OWN_ONCE = ['REFERENCE_NUMBER', 'FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME', 'UN_LIST_TYPE'] as const;

/** A name part or alias that carries a name: not empty, not the XSD default "na". */
function present(v: string | undefined): v is string {
  return !!v && v.length > 0 && v.toLowerCase() !== 'na';
}

/** Every nested container removed, so only the entry's OWN fields are left. */
function ownFields(entry: string): string {
  return entry.replace(
    /<(TITLE|DESIGNATION|NATIONALITY|LIST_TYPE|LAST_DAY_UPDATED|(?:INDIVIDUAL|ENTITY)_[A-Z_]+)>[\s\S]*?<\/\1>/g,
    '',
  );
}

/** Pure, strict parser. Throws ('UN SC: …') on any structural fault. */
export function parseUnScXml(xml: string): SanctionsList {
  try {
    return parseUnchecked(xml);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(ERR)) throw err;
    throw new Error(`${ERR} unparseable document (${err instanceof Error ? err.name : 'unknown'})`);
  }
}

function parseUnchecked(xml: string): SanctionsList {
  if (!/<CONSOLIDATED_LIST[\s>]/.test(xml)) throw new Error(`${ERR} unexpected document (no <CONSOLIDATED_LIST> root element)`);
  // A body cut off after N whole entries would otherwise parse cleanly.
  if (!/<\/CONSOLIDATED_LIST>\s*$/.test(xml)) throw new Error(`${ERR} truncated document (no closing </CONSOLIDATED_LIST>)`);
  const generated = /<CONSOLIDATED_LIST\b[^>]*?\sdateGenerated="([^"]*)"/.exec(xml)?.[1];
  if (!generated) throw new Error(`${ERR} missing date (no dateGenerated)`);
  const day = /^(\d{4}-\d{2}-\d{2})T/.exec(generated.trim());
  if (!day) throw new Error(`${ERR} unrecognised dateGenerated`);

  const entries: SanctionsListEntry[] = [];
  const ids = new Set<string>();
  let position = 0;
  for (const kind of ['INDIVIDUAL', 'ENTITY'] as const) {
    const blocks = [...xml.matchAll(new RegExp(`<${kind}>([\\s\\S]*?)</${kind}>`, 'g'))].map((m) => m[1]);
    // Every <INDIVIDUAL…>/<ENTITY…> opening and end tag must belong to a plain
    // block we read (an attribute, a namespace prefix, a self-closing form or
    // a spaced end tag is a structure we do not know), and no block may hold
    // another entry opening of either kind (L1-LF2, LB1).
    if (!entryElementsMatch(xml, kind, blocks, ENTRY_KINDS)) {
      throw new Error(`${ERR} unrecognised entry element (${kind.toLowerCase()})`);
    }
    for (const block of blocks) {
      position += 1;
      // L1-LF2 (LB2): a malformed element we read fails the parse (position only).
      const malformed = (name: string | null) => {
        if (name !== null) throw new Error(`${ERR} entry ${position} has a malformed <${name}> element`);
      };
      malformed(malformedElement(block, UN_LEAVES, [`${kind}_ALIAS`]));
      const own = ownFields(block);
      malformed(malformedElement(own, UN_LEAVES, [], UN_OWN_ONCE));
      const ref = tag(own, 'REFERENCE_NUMBER');
      if (!ref) throw new Error(`${ERR} entry ${position} has no reference number`);
      const parts =
        kind === 'INDIVIDUAL'
          ? ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME'].map((n) => tag(own, n)).filter(present)
          : [tag(own, 'FIRST_NAME')].filter(present);
      if (parts.length === 0) throw new Error(`${ERR} entry ${position} has no name`);
      // L1-LF2 (LB3): storeList keeps the first of two equal ids and drops the
      // second entry's names, so a repeated reference number fails the parse.
      if (ids.has(ref)) throw new Error(`${ERR} entry ${position} repeats an id`);
      ids.add(ref);
      const strong: string[] = [];
      const weak: string[] = [];
      for (const a of block.matchAll(new RegExp(`<${kind}_ALIAS>([\\s\\S]*?)</${kind}_ALIAS>`, 'g'))) {
        malformed(malformedElement(a[1], UN_LEAVES, [], ['ALIAS_NAME', 'QUALITY']));
        const name = tag(a[1], 'ALIAS_NAME');
        if (!present(name)) continue;
        // Low quality: "probably insufficient alone" (UN page) -> review only.
        if ((tag(a[1], 'QUALITY') ?? '').toLowerCase() === 'low') weak.push(name);
        else strong.push(name);
      }
      const regime = tag(own, 'UN_LIST_TYPE');
      const entry: SanctionsListEntry = {
        id: `unsc:${ref}`,
        names: [parts.join(' '), ...strong],
        type: kind === 'INDIVIDUAL' ? 'Individual' : 'Entity',
        programs: regime ? [regime] : [],
      };
      if (weak.length > 0) entry.weakNames = weak;
      entries.push(entry);
    }
  }
  if (entries.length === 0) throw new Error(`${ERR} no entries parsed`);
  return { source: 'un-sc', version: day[1], hash: hashEntries(entries), entries };
}

const PINNED_HOSTS: ReadonlySet<string> = new Set(['scsanctions.un.org', 'unsolprodfiles.blob.core.windows.net']);

/** https AND the hostname is EXACTLY one of the two verified hosts. */
function allowedUnFinalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && PINNED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Download and parse the live UN SC list. Bounded: the User-Agent, an abort
 * signal, a size cap (declared Content-Length and the actual body) and the
 * final URL pinned to the two verified hosts. Fetch errors read
 * 'UN SC fetch failed: ...'; parse errors start 'UN SC:'.
 */
export async function fetchUnScList(
  fetchImpl: typeof fetch = fetch,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<SanctionsList> {
  const maxBytes = opts.maxBytes ?? UN_SC_MAX_BYTES;
  const res = await fetchImpl(UN_SC_XML_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? UN_SC_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`UN SC fetch failed: HTTP ${res.status}`);
  // A stub without res.url is a test.
  if (res.url && !allowedUnFinalUrl(res.url)) throw new Error('UN SC fetch failed: unexpected host after redirect');
  const declared = Number(res.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('UN SC fetch failed: body too large');
  const body = await res.text();
  if (body.length > maxBytes) throw new Error('UN SC fetch failed: body too large');
  return parseUnScXml(body);
}
