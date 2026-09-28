import { renderableLogoSrc } from '@/lib/partner-logo-store';

/**
 * A partner's logo (as an <img src> ONLY, never CSS) or, when there is no renderable logo, the
 * brand name as text. Stored logos are passed through the logo store's render check, which keeps
 * legacy values renderable in an <img> (where an SVG cannot run script) and drops anything else.
 */
export function SiteBrand({ brand, logo }: { brand: string; logo: unknown }) {
  const src = renderableLogoSrc(logo);
  if (src) {
    // A data: URI or a legacy remote URL; next/image adds nothing for either.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={brand} className="h-9 w-auto" />;
  }
  return <span className="text-ds-ink font-extrabold">{brand}</span>;
}
