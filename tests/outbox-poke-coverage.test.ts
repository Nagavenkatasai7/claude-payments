import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// partner-demo R4 guard: with the Neon gate, a cron tick skips the database
// unless outbox work is MARKED due. A row whose producer never pokes (the poke
// is what marks it) waits for the :17/:47 backstop — up to 30 min — and on the
// way trips a false `draingap` page. So every src file that enqueues an outbox
// row must either
//   (a) call pokeWorker / pokeWorkerDelayed itself (post-response via after(),
//       so after the enqueue's transaction has committed), or
//   (b) be a HELPER listed below whose enqueuing functions are only ever
//       called from files that satisfy (a), from /api/worker itself (the
//       route marks the next due row after every full run), or from another
//       listed helper (resolved recursively).
// File-level grep: a new enqueue site in a file that already pokes is not
// caught at function granularity — keep the poke in the same function.

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');

/** Files that enqueue but do not poke → the exported functions whose callers must. */
const HELPERS: Record<string, string[]> = {
  // Only ever run inside an /api/worker invocation.
  'src/lib/reconcile.ts': ['reconcileSweep', 'enqueueReinstructLocked'],
  'src/lib/aml-sweep.ts': ['amlSweep'],
  'src/lib/rate-staleness.ts': ['sweepStaleRates', 'sweepFxHealth'],
  'src/lib/worker-cadence.ts': ['checkCronQuiet', 'sweepDrainGap'],
  'src/lib/outbox-worker.ts': ['drainOnce'],
  // Callers poke (or are the worker / the cron route, which pokes).
  'src/lib/stale-money.ts': ['escalateStuckPaid', 'expireUnpaidLinks'],
  'src/lib/cron-run.ts': ['runDueSchedules'],
  'src/lib/sanctions/list-loader.ts': ['runOfacSdnLoad'],
  'src/lib/providers/payment-provider.ts': ['getPaymentProvider'],
  'src/lib/stripe-funded-settle.ts': ['settleFundedTransfer'],
  'src/lib/settlement.ts': ['settleOrHold', 'beginSettlement', 'beginHold', 'releaseHold'],
};
/** The worker route drains in the same invocation and marks what is left. */
const WORKER_ROUTE = 'src/app/api/worker/route.ts';
const EXEMPT = new Set(['src/db/repos/outbox-repo.ts', 'src/lib/outbox.ts']);

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC, []).map((p) => ({ rel: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const pokes = (text: string) => /\bpokeWorker(Delayed)?\(/.test(text);

function callersOf(fn: string, self: string): string[] {
  const re = new RegExp(`\\b${fn}\\(`);
  return files.filter((f) => f.rel !== self && re.test(f.text) && !new RegExp(`function ${fn}\\(`).test(f.text)).map((f) => f.rel);
}

/** A file is covered if it pokes, is the worker route, or is a helper all of whose callers are covered. */
function covered(rel: string, seen = new Set<string>()): string[] {
  if (rel === WORKER_ROUTE) return [];
  const f = files.find((x) => x.rel === rel);
  if (f && pokes(f.text)) return [];
  const fns = HELPERS[rel];
  if (!fns) return [`${rel}: does not poke and is not a listed helper`];
  if (seen.has(rel)) return [];
  seen.add(rel);
  return fns.flatMap((fn) => callersOf(fn, rel).flatMap((c) => covered(c, seen).map((why) => `${why} (via ${fn} in ${rel})`)));
}

describe('every outbox enqueue site is followed by a worker poke (partner-demo R4)', () => {
  const enqueuers = files.filter((f) => !EXEMPT.has(f.rel) && /\.enqueue\(/.test(f.text)).map((f) => f.rel);

  it('finds the enqueue sites (the scan is not vacuous)', () => {
    expect(enqueuers.length).toBeGreaterThan(20);
    for (const helper of Object.keys(HELPERS)) expect(enqueuers, helper).toContain(helper);
  });

  it('each one pokes, or is a helper whose every caller pokes / is the worker', () => {
    expect(enqueuers.flatMap((rel) => covered(rel))).toEqual([]);
  });

  it('the six producers the R4 review found unpoked now poke', () => {
    for (const rel of [
      'src/app/api/payment-webhook/[provider]/route.ts',
      'src/app/api/persona-webhook/route.ts',
      'src/lib/kyc-case-store.ts',
      'src/lib/store.ts',
      'src/lib/limiter-alert.ts',
      'src/lib/stripe-funding-webhook.ts',
      'src/app/api/cron/route.ts',
      'src/lib/sender-cancel.ts',
    ]) {
      expect(pokes(files.find((f) => f.rel === rel)!.text), rel).toBe(true);
    }
  });
});
