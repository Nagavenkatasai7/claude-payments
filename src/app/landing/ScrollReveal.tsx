'use client';

import { useEffect } from 'react';

/**
 * Progressive-enhancement scroll reveal. Browsers that support CSS
 * scroll-driven animations (`animation-timeline: view()`) handle `.lp-reveal`
 * purely in CSS and never need this. For everyone else, one pooled
 * IntersectionObserver adds `.in-view` to each `.lp-reveal` as it enters,
 * triggering a normal CSS transition.
 *
 * Mounting this component is a no-op when:
 *  - the browser supports `animation-timeline: view()` (CSS handles it), or
 *  - the user prefers reduced motion (elements are shown immediately by CSS).
 */
export default function ScrollReveal() {
  useEffect(() => {
    // If native scroll-driven animations are supported, CSS already handles it.
    if (
      typeof CSS !== 'undefined' &&
      CSS.supports?.('animation-timeline: view()')
    ) {
      return;
    }

    const els = Array.from(
      document.querySelectorAll<HTMLElement>('.lp-reveal'),
    );
    if (els.length === 0) return;

    // Reduced motion: reveal everything immediately, skip the observer.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      els.forEach((el) => el.classList.add('in-view'));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.1 },
    );

    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return null;
}
