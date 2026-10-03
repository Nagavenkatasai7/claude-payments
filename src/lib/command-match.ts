// command-match: the ONE search rule behind both command palettes (the legacy /admin-dashboard
// palette and the /partner one). Pure and client-safe. Every whitespace-separated term of the query
// must appear (AND match), case-insensitive, in the label, the group or the extra keywords.
export interface MatchableCommand {
  label: string;
  group: string;
  /** Extra search terms (not displayed). */
  keywords?: string;
}

export function matchesCommand(item: MatchableCommand, q: string): boolean {
  if (!q) return true;
  const hay = `${item.label} ${item.group} ${item.keywords ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}
