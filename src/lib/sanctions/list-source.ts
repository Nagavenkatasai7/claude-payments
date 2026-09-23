// The sanctions-list seam (Program-Fix 14 step 7). A list is loaded by a
// SanctionsListSource (Postgres since PR C: pg-list-source.ts) and
// screened by ListSanctionsScreener. Screening itself is never optional: the
// SANCTIONS_LIST flag only picks WHICH list the screener uses.

export interface SanctionsListEntry {
  /** Stable list id, e.g. 'sdn:36' (the SDN uid). Evidence cites this, never a name. */
  id: string;
  /** Primary name first, then the STRONG AKAs. An exact match on any of these blocks. */
  names: string[];
  /**
   * PR C: the WEAK AKAs (OFAC <category>weak</category>: short or generic
   * aliases such as a bare acronym). OFAC does not expect weak AKAs to drive
   * automatic blocking, so an exact match on one is a possible match for HUMAN
   * review, never a block and never a silent pass. Absent = none.
   */
  weakNames?: string[];
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
  /** The list to screen against. Rejects when none is available (the screener then fails closed). */
  load(): Promise<SanctionsList>;
  /** PR C: refresh ahead of the hot path (outside any transaction). Never throws. */
  warm?(): Promise<void>;
}
