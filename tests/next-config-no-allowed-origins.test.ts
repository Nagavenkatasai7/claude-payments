import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import nextConfig from '../next.config';

// M2-2 Task 2.4. Server Actions get Next's Origin-vs-Host CSRF check ONLY while no
// extra origins are allowed: `serverActions.allowedOrigins` widens the set of hosts
// that may invoke an action (node_modules/next/dist/docs/01-app/02-guides/
// data-security.md:550-552). The customer portal's actions rely on that check,
// and partner subdomains make a wildcard entry especially dangerous (one partner's
// page could post to another's actions). This pin keeps it unset.

const CONFIG_FILES = ['next.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.cjs'].filter((f) => existsSync(f));

describe('next.config sets no serverActions.allowedOrigins', () => {
  it('the config file exists and is the one scanned', () => {
    expect(CONFIG_FILES).toContain('next.config.ts');
  });
  it('no config file mentions allowedOrigins', () => {
    for (const f of CONFIG_FILES) expect(readFileSync(f, 'utf8'), f).not.toMatch(/allowedOrigins/);
  });
  it('the loaded config has no serverActions origin list', () => {
    const cfg = nextConfig as { experimental?: { serverActions?: { allowedOrigins?: unknown } }; serverActions?: { allowedOrigins?: unknown } };
    expect(cfg.experimental?.serverActions?.allowedOrigins).toBeUndefined();
    expect(cfg.serverActions?.allowedOrigins).toBeUndefined();
  });
});
