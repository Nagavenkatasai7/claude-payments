// OFAC consolidated (non-SDN) list loader (fix pack 5 T26b, R08, P27;
// orchestrator decision D11, index.md owner question 22).
//
// Verified directly on 2026-11-11 (WebFetch, official OFAC / Treasury pages):
// - Download URL: https://sanctionslist.ofac.treas.gov/Home/static/consolidated.html
//   lists CONSOLIDATED.XML at
//   https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML
//   (the same Sanctions List Service host and path as SDN.XML, so the SDN
//   loader's redirect pin applies unchanged).
// - Root element and namespace: https://ofac.treasury.gov/recent-actions/20240507_44
//   ("Change to namespace in SDN.XML, CONSOLIDATED.XML, ...") gives, for both
//   files, the root <sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">.
// - One shared XSD: the same notice says "The XSD for these files has been
//   updated" (one XML.xsd for SDN.XML and CONSOLIDATED.XML), and
//   https://ofac.treasury.gov/recent-actions/20141010 says "These consolidated
//   files comply with all of OFAC's existing data standards".
//
// Follows from the shared XSD (NOT read from the consolidated file itself):
// the element names are those of SDN.XML, which ofac-sdn-loader.ts took from
// the live SDN export (2026-09-23): <publshInformation><Publish_Date>MM/DD/YYYY,
// <sdnEntry> with <uid>, <firstName>, <lastName>, <sdnType>,
// <programList><program>, and <akaList><aka> whose alias quality is
// <category>strong|weak. A weak a.k.a. goes to weakNames (review, never an
// automatic block), exactly as the SDN parser does; OFAC FAQ 123
// (https://ofac.treasury.gov/faqs/123) loosely calls that field "Type".
// So this loader reuses parseOfacSdnXml with source 'ofac-cons', ids
// 'cons:<uid>' and errors 'OFAC CONS:', in STRICT mode: no <sdnList> root or
// no </sdnList> end, an entry without a uid or a primary name, zero entries or
// no Publish_Date fails the WHOLE parse, so a different structure never loads
// a partial list (the last good version stays active, runListLoad alerts).
// Fix pack 5 L1-LF2 (parseStrict in ofac-sdn-loader.ts) adds: any <sdnEntry>
// opening or end tag outside a plain <sdnEntry>…</sdnEntry> block (no end
// tag, an attribute, a namespace prefix) -> 'unrecognised entry element'; a
// malformed element the parser reads (uid, firstName, lastName, sdnType,
// category, program, aka, akaList, programList) -> 'entry <n> has a
// malformed <X> element'; a repeated uid -> 'entry <n> repeats an id'.
// Entities are decoded in one pass, before the trim. Empty and self-closing
// optional elements stay accepted.
//
// Not opened from the build machine (the OFAC host answers 403 through its
// proxy): the XSD file (XML.xsd) and the live CONSOLIDATED.XML.
//
// Owner step: the first live load on a preview deployment, with a count check
// against OFAC's page, comes before SANCTIONS_LIST=lists is ever set.
//
// The test fixture (tests/fixtures/ofac-cons-sample.xml) is hand-built to this
// structure with INVENTED names. No call site in src yet: fix pack 5 T30 wires
// the cron (only with SANCTIONS_LOADER_ENABLED and SANCTIONS_LIST=lists).

import type { SanctionsList } from './list-source';
import { allowedFinalUrl, parseOfacSdnXml, type SdnXmlParseOptions } from './ofac-sdn-loader';
import { fetchPinnedText } from './pinned-fetch';

export const OFAC_CONS_XML_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML';

/**
 * A conservative floor below the expected few hundred consolidated entries
 * (assumed, P33 T26): the owner's first live load on a preview confirms the
 * count (index.md owner step). runListLoad refuses a smaller list.
 */
export const OFAC_CONS_MIN_ENTRIES = 100;
/** The consolidated list is far smaller than SDN.XML; anything past this is not the list. */
export const OFAC_CONS_MAX_BYTES = 20 * 1024 * 1024;
/** A hung download must not eat the cron's 300 s budget. */
export const OFAC_CONS_FETCH_TIMEOUT_MS = 60_000;

const CONS_PARSE: SdnXmlParseOptions = {
  source: 'ofac-cons',
  idPrefix: 'cons',
  errorPrefix: 'OFAC CONS:',
  strict: true,
};

/** Pure, strict parser for CONSOLIDATED.XML. Throws 'OFAC CONS: …' on any structural fault. */
export function parseOfacConsolidatedXml(xml: string): SanctionsList {
  return parseOfacSdnXml(xml, CONS_PARSE);
}

/**
 * Download and parse the live consolidated list. Bounded (fetchPinnedText):
 * the User-Agent, one abort signal, each redirect hop checked BEFORE it is
 * requested against the SDN pin (allowedFinalUrl: https on the SLS host or
 * its us-gov-west-1 S3 host; at most 3 hops), and a byte cap applied while
 * the body streams. Fetch errors read 'OFAC CONS fetch failed: ...'; parse
 * errors start 'OFAC CONS:'.
 */
export async function fetchOfacConsolidated(
  fetchImpl: typeof fetch = fetch,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<SanctionsList> {
  const body = await fetchPinnedText(OFAC_CONS_XML_URL, fetchImpl, {
    label: 'OFAC CONS',
    maxBytes: opts.maxBytes ?? OFAC_CONS_MAX_BYTES,
    timeoutMs: opts.timeoutMs ?? OFAC_CONS_FETCH_TIMEOUT_MS,
    allowedUrl: allowedFinalUrl,
  });
  return parseOfacConsolidatedXml(body);
}
