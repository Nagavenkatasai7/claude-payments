'use client';

import { useEffect } from 'react';

/**
 * Toggles `.lp-nav--scrolled` on the sticky nav once the page scrolls past a
 * tiny sentinel near the top. Uses an IntersectionObserver on the sentinel
 * (cheaper than a scroll listener) — when the sentinel leaves the viewport the
 * nav gains its frosted background + hairline border.
 */
export default function NavScroll() {
  useEffect(() => {
    const sentinel = document.getElementById('lp-nav-sentinel');
    const nav = document.querySelector('.lp-nav');
    if (!sentinel || !nav) return;

    const io = new IntersectionObserver(
      ([entry]) => {
        nav.classList.toggle('lp-nav--scrolled', !entry.isIntersecting);
      },
      { threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);

  return null;
}
