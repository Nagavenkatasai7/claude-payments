import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(n)) out.push(p);
  }
  return out;
}

describe('fonts are self-hosted (SPEC §1.2)', () => {
  const layout = readFileSync('src/app/layout.tsx', 'utf8');
  it('the root layout loads Inter via next/font as the --font-inter variable, lang="en"', () => {
    expect(layout).toMatch(/import \{ Inter \} from 'next\/font\/google'/);
    expect(layout).toMatch(/variable: '--font-inter'/);
    expect(layout).not.toMatch(/weight:/); // variable font ⇒ 100–900, including the landing's 800
    expect(layout).toMatch(/<html lang="en" className=\{inter\.variable\}>/);
  });
  it('the Tailwind sans stack consumes it', () => {
    expect(readFileSync('src/app/tailwind.css', 'utf8')).toContain('--font-sans: var(--font-inter), ui-sans-serif, system-ui, sans-serif;');
  });
  it('no source file references a font CDN', () => {
    for (const f of walk('src')) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/fonts\.(googleapis|gstatic)\.com|use\.typekit|fonts\.bunny/);
    }
  });
  it('the CSP font-src is unchanged', async () => {
    const { buildCsp } = await import('@/lib/csp');
    expect(buildCsp({ isDev: false })).toContain("font-src 'self' data:;");
  });
});
