import type { Metadata } from 'next';
import { getPortalSite } from './portal-site';
import { NOT_FOUND_METADATA } from './not-found-metadata';
import { t, type MessageKey } from './i18n';

/**
 * portalMetadata — every portal page's (and the layout's) generateMetadata (UI redesign M2, L8).
 *
 * On the apex (or with the portal off) every portal route is a 404, but Next still resolves the
 * route's metadata: the page's for the streamed head, and on the not-found path every layout's
 * (node_modules/next/dist/lib/metadata/resolve-metadata.js collectMetadata). A static `metadata`
 * export therefore leaked the portal's structure onto the apex 404. This returns the page's
 * metadata only when getPortalSite() resolves, else the root 404's own metadata. Not {}: that leaves
 * the root layout's "SmartRemit" in the RSC head, while an unmatched URL's says "Page not found"
 * (seen on `next start`), which still marks the route. Every apex portal route is a 404, so the
 * 404 metadata is always right there.
 */
export async function portalMetadata(
  title: MessageKey | null,
  extra: Omit<Metadata, 'title'> = {},
): Promise<Metadata> {
  if (!(await getPortalSite())) return NOT_FOUND_METADATA;
  return title ? { title: t(title), ...extra } : { ...extra };
}

/**
 * The portal not-found's metadata. On the not-found path the DEEPEST not-found module's metadata
 * wins (collectMetadata's errorMetadataItem), so on the apex this must be the root 404's own
 * metadata; on a portal site it stays {} (unchanged partner-site behaviour).
 */
export async function portalNotFoundMetadata(): Promise<Metadata> {
  return (await getPortalSite()) ? {} : NOT_FOUND_METADATA;
}
