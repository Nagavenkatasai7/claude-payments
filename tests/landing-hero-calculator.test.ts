import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Owner ask (Oct 30): the FX calculator moves to the top right of the hero, the phone
// picture of the payment chat moves down to where the calculator was, and the page keeps
// one calculator. Static source checks, like landing-channels.test.ts.
const PAGE = readFileSync(resolve(process.cwd(), 'src/app/page.tsx'), 'utf-8');

function sectionAt(id: string): string {
  // The attribute sits on its own line; a comment may also mention id="main".
  const at = PAGE.search(new RegExp(`\\n\\s+id="${id}"\\n`));
  expect(at, `section #${id}`).toBeGreaterThan(-1);
  const start = PAGE.lastIndexOf('<section', at);
  return PAGE.slice(start, PAGE.indexOf('</section>', at));
}

const count = (needle: string) => PAGE.split(needle).length - 1;

describe('home page: calculator at the top, phone picture below', () => {
  it('the hero shows the calculator, not the phone picture', () => {
    const hero = sectionAt('main');
    expect(hero).toContain('<RateCalculator');
    expect(hero).not.toContain('<ChatMock');
  });

  it('keeps one calculator, and the menu rate chip still lands on it', () => {
    expect(count('<RateCalculator')).toBe(1);
    expect(count('id="calculator"')).toBe(1);
    expect(sectionAt('main')).toContain('id="calculator"');
    expect(PAGE).toContain('href="#calculator"');
  });

  it('the hero calculator carries the short rate line', () => {
    const hero = sectionAt('main');
    expect(hero).toContain('daily reference rate');
    expect(hero).toMatch(/You see the exact rate and total before\s+you pay\./);
  });

  it('the phone picture moves to its own section below', () => {
    expect(count('<ChatMock')).toBe(1);
    const chat = sectionAt('chat-demo');
    expect(chat).toContain('<ChatMock');
    expect(chat).toContain('Quote, check and pay in one chat.');
  });
});
