// The DS token facts TypeScript needs. Pinned equal to src/app/tailwind.css by tests/ds-tokens.test.ts.
export const OVERRIDABLE_TOKENS = ['--ds-primary', '--ds-primary-hover', '--ds-accent', '--ds-gradient-text'] as const;
export const DEFAULT_THEME = { primary: '#0c5bd2', accent: '#0e7490' } as const;
/** The text/surface tokens a partner colour must contrast with (§1.4). */
export const CONTRAST_REFERENCES = { onPrimary: '#ffffff', ground: '#f5f9ff' } as const;
export const MIN_CONTRAST = 4.5;
