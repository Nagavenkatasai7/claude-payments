import type { ReactNode } from 'react';

/**
 * Monochrome inline-SVG icons for the landing trust bar.
 *
 * These replace the previous emoji (🔒 📈 🌐 🏦). Emoji are rendered by the OS,
 * so they look different on Windows / macOS / Android — and some glyphs (notably
 * flags, but also weather/finance symbols) don't render at all on desktop Chrome.
 * Inline SVG renders identically everywhere and inherits the chip's text colour
 * via `currentColor`.
 */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function LockIcon() {
  return (
    <Icon>
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Icon>
  );
}

export function RateIcon() {
  return (
    <Icon>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M21 7v5h-5" />
    </Icon>
  );
}

export function GlobeIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" />
    </Icon>
  );
}

export function BankIcon() {
  return (
    <Icon>
      <path d="M3 10l9-6 9 6" />
      <path d="M5 10v8M9 10v8M15 10v8M19 10v8" />
      <path d="M3 21h18" />
    </Icon>
  );
}
