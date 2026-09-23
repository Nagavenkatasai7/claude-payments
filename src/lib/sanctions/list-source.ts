// The sanctions-list seam (Program-Fix 14 step 7). A list is loaded by a
// SanctionsListSource (a checked-in snapshot today; Postgres in PR C) and
// screened by ListSanctionsScreener. Screening itself is never optional: the
// SANCTIONS_LIST flag only picks WHICH list the screener uses.

export interface SanctionsListEntry {
  /** Stable list id, e.g. 'sdn:36' (the SDN uid). Evidence cites this, never a name. */
  id: string;
  /** Primary name first, then AKAs. */
  names: string[];
  /** 'Individual' | 'Entity' | 'Vessel' | 'Aircraft' | … as published. */
  type: string;
  programs: string[];
}

export interface SanctionsList {
  source: string;   // e.g. 'ofac-sdn'
  version: string;  // the publication date (YYYY-MM-DD)
  hash: string;     // sha256 over the canonical entries
  entries: SanctionsListEntry[];
}

export interface SanctionsListSource {
  load(): Promise<SanctionsList>;
}
