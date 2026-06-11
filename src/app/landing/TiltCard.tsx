'use client';

import { useRef, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  className?: string;
  /** Max tilt in degrees. Hero mock uses a smaller value than cards. */
  max?: number;
}

/**
 * Pointer-tilt wrapper — pure progressive enhancement. Gated to fine pointers
 * via CSS (`@media (hover:hover) and (pointer:fine)`) AND a runtime check, and
 * disabled under prefers-reduced-motion. Reads-then-writes inside one rAF to
 * avoid layout thrash; `will-change` is set only while hovering and cleared on
 * leave so we don't keep a compositor layer alive.
 */
export default function TiltCard({ children, className = '', max = 6 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);

  const allowed = () => {
    if (typeof window === 'undefined') return false;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return false;
    }
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!allowed()) return;
    const el = ref.current;
    if (!el) return;
    const { clientX, clientY } = e;
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      const px = (clientX - rect.left) / rect.width - 0.5; // -0.5..0.5
      const py = (clientY - rect.top) / rect.height - 0.5;
      const rotY = px * max * 2;
      const rotX = -py * max * 2;
      el.style.willChange = 'transform';
      el.style.transform = `perspective(900px) rotateX(${rotX.toFixed(
        2,
      )}deg) rotateY(${rotY.toFixed(2)}deg)`;
    });
  };

  const reset = () => {
    const el = ref.current;
    if (!el) return;
    if (frame.current != null) cancelAnimationFrame(frame.current);
    el.style.transform = '';
    el.style.willChange = '';
  };

  return (
    <div
      ref={ref}
      className={`[transition:transform_.25s_ease] ${className}`.trim()}
      onPointerMove={onMove}
      onPointerLeave={reset}
    >
      {children}
    </div>
  );
}
