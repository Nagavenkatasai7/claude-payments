import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WAITLIST_DESTINATIONS } from '@/app/landing/corridors';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from '@/lib/types';

// Program-Fix 33 (docs-06): the landing page advertised "8 corridors" with
// eight flag pills while the product served ten. The count now follows
// landing/corridors.ts and every COUNTRIES entry has a self-hosted flag.
// COUNTRIES is not exported (a Next.js page module may export only Next's
// conventions), so this reads the page source.
const PAGE = readFileSync(resolve(process.cwd(), 'src/app/page.tsx'), 'utf-8');

function landingCountries(): Array<{ name: string; code: string }> {
  const block = PAGE.match(/const COUNTRIES = \[([\s\S]*?)\];/);
  expect(block, 'COUNTRIES array not found in src/app/page.tsx').not.toBeNull();
  return [...block![1].matchAll(/\{\s*name:\s*'([^']+)',\s*short:\s*'[^']+',\s*code:\s*'([a-z]{2})'\s*\}/g)]
    .map((m) => ({ name: m[1], code: m[2] }));
}

describe('landing page corridors (Program-Fix 33)', () => {
  it('has no literal "8 corridors" — the count is derived', () => {
    expect(PAGE).not.toContain('8 corridors');
    expect(PAGE).toContain('${CORRIDOR_COUNT} corridors');
    expect(PAGE).toContain('{CORRIDOR_COUNT} corridors');
  });

  it('the derived count is the waitlist destination list (10) and matches the country authority', () => {
    expect(WAITLIST_DESTINATIONS).toHaveLength(10);
    expect(WAITLIST_DESTINATIONS.map((d) => d.value).sort()).toEqual(Object.keys(DEFAULT_CURRENCY_FOR_COUNTRY).sort());
  });

  it('COUNTRIES lists all ten, including Hong Kong and Mexico', () => {
    const countries = landingCountries();
    expect(countries).toHaveLength(10);
    expect(countries.map((c) => c.code.toUpperCase()).sort()).toEqual(Object.keys(DEFAULT_CURRENCY_FOR_COUNTRY).sort());
    expect(countries.map((c) => c.name)).toContain('Hong Kong');
    expect(countries.map((c) => c.name)).toContain('Mexico');
  });

  it('every COUNTRIES code has a flag file in public/flags/', () => {
    for (const c of landingCountries()) {
      const file = resolve(process.cwd(), 'public/flags', `${c.code}.svg`);
      expect(existsSync(file), `missing ${file}`).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain('<svg');
    }
  });
});
