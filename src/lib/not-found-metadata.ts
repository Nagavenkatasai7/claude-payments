import type { Metadata } from 'next';

/**
 * The root 404's metadata (Program-Fix 41): brand-neutral, the title only. Shared with the portal
 * not-found so an apex portal 404 carries exactly the same head as any unmatched URL (L8).
 */
export const NOT_FOUND_METADATA: Metadata = { title: 'Page not found' };
