import Image from 'next/image';

// The SmartRemit.ai logo (stacked mark + wordmark, 1028x533 source in
// /public/brand). Explicit width/height keep the 1028:533 aspect ratio so
// next/image reserves the box (no layout shift); the optimizer serves 1x/2x
// candidates for the rendered width, so it stays crisp on retina.
// Next 16 deprecates `priority` in favour of `preload` and recommends
// `loading="eager"` for above-the-fold images (next/dist/docs .../image.md).

const LOGO_W = 1028;
const LOGO_H = 533;

export default function BrandLogo({
  height = 32,
  eager = false,
  className = '',
}: {
  /** Rendered height in CSS px; width follows the logo's aspect ratio. */
  height?: number;
  /** true for the nav instance (above the fold). */
  eager?: boolean;
  className?: string;
}) {
  const width = Math.round((height * LOGO_W) / LOGO_H);
  return (
    <Image
      src="/brand/smartremit-logo.png"
      alt="SmartRemit.ai"
      width={width}
      height={height}
      loading={eager ? 'eager' : 'lazy'}
      className={`block max-w-none ${className}`}
      style={{ width, height }}
    />
  );
}
