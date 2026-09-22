'use client';

import { useEffect, useRef } from 'react';

// A <video> whose file is attached only when it comes within 200px of the
// viewport, so a below-the-fold demo never competes with the page's LCP.
// The server markup carries the poster and data-src only. Muted + playsInline
// satisfy mobile autoplay policies; under prefers-reduced-motion it does not
// autoplay (the controls stay, so it can still be played by hand).
export default function LazyVideo({
  src,
  poster,
  label,
  className,
}: {
  src: string;
  poster: string;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const attach = () => {
      if (el.getAttribute('src')) return;
      el.muted = true;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) el.autoplay = false;
      el.src = src;
    };
    if (!('IntersectionObserver' in window)) {
      attach();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          attach();
          io.disconnect();
        }
      },
      { rootMargin: '200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [src]);

  return (
    <video
      ref={ref}
      className={className}
      data-src={src}
      poster={poster}
      muted
      playsInline
      loop
      autoPlay
      preload="metadata"
      controls
      aria-label={label}
    />
  );
}
