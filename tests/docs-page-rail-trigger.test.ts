import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { isUnreachableAccount } from '@/app/api/partner-rail/route';

const PAGE = readFileSync(join(__dirname, '..', 'src', 'app', 'docs', 'page.tsx'), 'utf8');

/** The /docs paragraph that documents the hosted reference rail's failure trigger. */
function railParagraph(): string {
  const start = PAGE.indexOf('reference rail</strong>');
  expect(start).toBeGreaterThan(-1);
  const end = PAGE.indexOf('</p>', start);
  return PAGE.slice(start, end);
}

/** The first bullet of the webhook status table that documents failed / returned. */
function failedBullet(): string {
  const start = PAGE.indexOf('<code>failed</code> / <code>returned</code>');
  expect(start).toBeGreaterThan(-1);
  const end = PAGE.indexOf('</li>', start);
  return PAGE.slice(start, end).replace(/\s+/g, ' ');
}

describe('/docs reference-rail failure example', () => {
  it('documents a destination the reference rail actually treats as unreachable', () => {
    const examples = [...railParagraph().matchAll(/<code>([^<]*\|[^<]*)<\/code>/g)].map((m) => m[1]);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) expect(isUnreachableAccount(example)).toBe(true);
  });

  it('states that the account number must be the last group of digits', () => {
    expect(railParagraph().replace(/\s+/g, ' ')).toMatch(/last group of digits/);
  });
});

describe('/docs failed / returned refund wording (src/lib/rail-failure.ts)', () => {
  it('names all three refund paths: captured charge, partner-pulled reverse, partner returns funds', () => {
    const bullet = failedBullet();
    expect(bullet).toMatch(/If SmartRemit captured the charge/);
    expect(bullet).toMatch(/partner-pulled debit gets a signed <code>reverse<\/code>/);
    expect(bullet).toMatch(/otherwise you return the funds/);
  });
});
