import Image from 'next/image';

// The SmartRemit.ai horizontal lockup (mark + wordmark, 904x160 source in
// /public/brand, built by scripts/render-brand-lockup.mjs from the stacked
// logo). `height` is the intrinsic size handed to next/image: it keeps the
// 904:160 ratio so the box is reserved (no layout shift), and the optimizer's
// 1x/2x candidates are generated for it, so pass the LARGEST height the logo
// renders at and shrink it per breakpoint with `className` (e.g.
// "h-9 sm:h-10"). Next 16 deprecates `priority` in favour of `preload`;
// above-the-fold images use loading="eager"
// (next/dist/docs/01-app/03-api-reference/02-components/image.md).

const LOCKUP_W = 904;
const LOCKUP_H = 160;

export default function BrandLogo({
  height = 40,
  eager = false,
  className = 'h-10',
}: {
  /** Largest rendered height in CSS px; width follows the lockup ratio. */
  height?: number;
  /** true for the nav instance (above the fold). */
  eager?: boolean;
  /** Height utilities for the rendered size (width stays auto). */
  className?: string;
}) {
  return (
    <Image
      src="/brand/smartremit-lockup.png"
      alt="SmartRemit.ai"
      width={Math.round((height * LOCKUP_W) / LOCKUP_H)}
      height={height}
      loading={eager ? 'eager' : 'lazy'}
      // aspect-ratio pins the box to the source ratio: the optimizer's variants
      // round their height (256x45), which would otherwise skew width: auto.
      className={`block aspect-[904/160] w-auto max-w-none ${className}`}
    />
  );
}
