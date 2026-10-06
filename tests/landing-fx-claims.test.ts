import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Step 0 FX-8: the public pages may not call the platform's rate "mid-market"
// or promise "no (hidden) markup". The rate is the ECB's daily REFERENCE rate,
// published "for information purposes only" (step0-rate-fixes.md §2), and a
// routed transfer is priced on a partner's rate. src/app/page.tsx is deferred
// to the landing follow-up (collision list), so it is not checked here.
// Static grep over the sources, like landing-claims.test.ts.
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8');
const FILES = [
  'src/app/about/page.tsx',
  'src/app/landing/RateCalculator.tsx',
  'src/app/landing/HeroPipeline.tsx',
  'src/app/landing/showcase.tsx',
  'src/app/docs/page.tsx',
];

describe('public FX claims (Step 0 FX-8)', () => {
  for (const f of FILES) {
    it(`${f} never says "mid-market" or promises no markup`, () => {
      const src = read(f);
      expect(src).not.toMatch(/mid[\s-]?market/i);
      expect(src).not.toMatch(/(no|zero) (hidden )?markup/i);
      expect(src).not.toMatch(/hidden markup/i);
    });
  }

  it('the calculator names the rate as the daily reference rate', () => {
    expect(read('src/app/landing/RateCalculator.tsx')).toMatch(/daily reference rate/i);
  });
});
