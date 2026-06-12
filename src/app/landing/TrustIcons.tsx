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

export function BankIcon() {
  return (
    <Icon>
      <path d="M3 10l9-6 9 6" />
      <path d="M5 10v8M9 10v8M15 10v8M19 10v8" />
      <path d="M3 21h18" />
    </Icon>
  );
}

export function ShieldIcon() {
  return (
    <Icon>
      <path d="M12 3l8 3v6c0 4.5-3.2 7.7-8 9-4.8-1.3-8-4.5-8-9V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </Icon>
  );
}

export function AuditIcon() {
  return (
    <Icon>
      <path d="M8 4h10a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7l3-3z" />
      <path d="M9 11h6M9 15h6" />
    </Icon>
  );
}

export function BadgeIcon() {
  return (
    <Icon>
      <circle cx="12" cy="9" r="5" />
      <path d="M8.5 13.5L7 21l5-2.5L17 21l-1.5-7.5" />
    </Icon>
  );
}
