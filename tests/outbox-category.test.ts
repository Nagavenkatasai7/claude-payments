import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Program-Fix 49A (whatsapp-10d): every producer of a customer-facing
// WhatsApp outbox row states its consent category, so the worker can honour
// STOP (src/lib/consent-gate.ts). Static: walks src/ and, for every
// `enqueue('whatsapp.text' | 'whatsapp.template', …)`, requires a `category:`
// field in that call's payload. A missing category still delivers (essential),
// so this test is what keeps a NEW nonessential sender from silently ignoring STOP.

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');

// Sites deliberately NOT tagged in this PR. tools.ts is owned by 49B (prompt
// and tool consistency) and is not edited here; both rows default to
// essential (today's behaviour) until 49B tags them.
const NOT_YET_TAGGED: Record<string, number> = {
  'src/lib/tools.ts': 2, // B2B bill push to the buyer (B5: nonessential) + the seller's own link
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

function enqueueCalls(src: string): string[] {
  const calls: string[] = [];
  const re = /enqueue\(\s*'whatsapp\.(?:text|template)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // The call's arguments run to its dedupe options (every producer sets one)
    // or, failing that, a bounded window.
    const rest = src.slice(m.index);
    const end = rest.indexOf('dedupeKey');
    calls.push(rest.slice(0, end > 0 ? end : 800));
  }
  return calls;
}

describe('every whatsapp.* outbox producer tags a consent category', () => {
  const files = walk(SRC);
  const perFile = files
    .map((f) => ({ file: relative(ROOT, f), calls: enqueueCalls(readFileSync(f, 'utf8')) }))
    .filter((x) => x.calls.length > 0);

  it('finds the known producers (the scan is not vacuous)', () => {
    const total = perFile.reduce((n, x) => n + x.calls.length, 0);
    expect(total).toBeGreaterThanOrEqual(10);
    expect(perFile.map((x) => x.file)).toEqual(
      expect.arrayContaining(['src/lib/settlement.ts', 'src/lib/rail-failure.ts', 'src/lib/outbox-worker.ts']),
    );
  });

  it('each call carries category: (except the listed not-yet-tagged sites)', () => {
    const untagged: Record<string, number> = {};
    for (const { file, calls } of perFile) {
      const n = calls.filter((c) => !/\bcategory:/.test(c)).length;
      if (n > 0) untagged[file] = n;
    }
    expect(untagged).toEqual(NOT_YET_TAGGED);
  });
});
