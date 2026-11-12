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
  'src/lib/reconcile.ts': ['reconcileSweep', 'enqueueReinstructLocked', 'reinstructLocked'],
  'src/lib/aml-sweep.ts': ['amlSweep'],
  'src/lib/rate-staleness.ts': ['sweepStaleRates', 'sweepFxHealth'],
  'src/lib/worker-cadence.ts': ['checkCronQuiet', 'sweepDrainGap'],
  'src/lib/outbox-worker.ts': ['drainOnce'],
  // Callers poke (or are the worker / the cron route, which pokes).
  'src/lib/stale-money.ts': ['escalateStuckPaid', 'expireUnpaidLinks'],
  'src/lib/cron-run.ts': ['runDueSchedules'],
  'src/lib/sanctions/list-loader.ts': ['runOfacSdnLoad', 'runListLoad'],
  // partner-demo R3a: the storage cap-watch — called only from the cron route.
  'src/lib/storage-watch.ts': ['checkStorageCap'],
  // Fix pack 2 (R02): the list-not-live alert — called only from the cron route.
  'src/lib/sanctions/list-health.ts': ['checkSanctionsListHealth'],
  // Fix pack 2 T7 (R07): the archive-failed / unconfigured alerts; pack 5 LC2: the lag alert — called only from the cron route.
  'src/lib/sanctions/list-archive.ts': ['archivePending', 'alertArchiveLag'],
  // Fix pack 2 T5 (R04): the block notices — enqueued inside each block's own
  // transaction; every caller pokes after it commits (store.ts recordSanctionsBlock,
  // pay-rescreen, payment-link-*, tools) or is a listed helper (settlement.ts).
  'src/lib/sanctions/notices.ts': ['enqueueSanctionsBlockNotices'],
  'src/lib/providers/payment-provider.ts': ['getPaymentProvider'],
  'src/lib/stripe-funded-settle.ts': ['settleFundedTransfer'],
  'src/lib/settlement.ts': ['settleOrHold', 'beginSettlement', 'beginHold', 'releaseHold', 'releaseRescreenedHold', 'releaseHoldAfterRescreen'],
  // R2a: the partner alert email.send — called from drainOnce (the worker) and
  // the inbound webhook path (whatsapp-inbound.ts, which pokes).
  'src/lib/channel-health.ts': ['recordChannelHealth'],
  // UI redesign M2-11b: the automatic receipt row, enqueued inside the delivered
  // transition. Only Store.updateTransferFromWebhook calls it, reached from the
  // payment-webhook route (which pokes) and the worker's mock.settle.
  'src/lib/delivery-receipt.ts': ['deliverTransfer'],
  // Release safety part A: the switch ops alert; its one caller, the
  // /admin-dashboard/switches action, pokes.
  'src/lib/flag-switch.ts': ['applyFlagChange', 'applyPartnerFlagChange'],
  // Fix pack 3 T9 (contract 9): the typed live-controls writers run in the caller's
  // transaction; their callers (the partner / platform live-controls actions) poke.
  // Fix pack 4 T5 (C11): notifyLiveChange (the alert + email half, no audit row) is also called by
  // partner-support-settings.ts setDisclosure, listed below.
  'src/lib/live-controls-write.ts': ['writePosture', 'writeComplianceUser', 'writeContract', 'writeCertification', 'writeOptIn', 'notifyLiveChange', 'writeFundingMode'],
  // Fix pack 4 T5 (C11): no .enqueue( of its own; setDisclosure calls notifyLiveChange
  // (live-controls-write.ts) when a platform save clears a certified partner's provider
  // approval. Its two callers (the partner settings and the admin partner disclosure actions) poke.
  'src/lib/partner-support-settings.ts': ['setDisclosure'],
  // Pack 3 review I1: the livegate:stuck: alert — called only from the two
  // stuck-paid sweeps (reconcileSweep, escalateStuckPaid), listed above.
  'src/lib/livegate-alerts.ts': ['alertStuckLivegate'],
  // Fix pack 5 T6 (P9): the <reason>:stuck:<id> alert, the same rule, called
  // only from the same two stuck-paid sweeps.
  'src/lib/instruct-gates.ts': ['alertStuckHeld'],
  // Fix pack 4 T8 (C8, critic M9): the payevidence:<hour> alert when a pay-page
  // payment's evidence could not be written; its callers (pay-process.ts, the
  // B2B pay route and, from review R1-P1 A2, the transfer pay route) poke.
  'src/lib/payment-evidence.ts': ['alertPayEvidenceUnavailable'],
  // Release safety part D: the deploy error watch runs only inside /api/worker.
  'src/lib/deploy-error-watch.ts': ['deployErrorWatch'],
};
/**
 * Listed helpers with no .enqueue( of their own: they reach the outbox only through a listed
 * function of ANOTHER helper. Fix pack 4 T5 (C11): setDisclosure -> notifyLiveChange
 * (live-controls-write.ts). Every other helper must enqueue itself (the not-vacuous check).
 */
const INDIRECT = new Set(['src/lib/partner-support-settings.ts']);
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
    // Every listed helper enqueues itself, except the named INDIRECT ones (R2-Q3 G2).
    for (const helper of Object.keys(HELPERS)) {
      if (!INDIRECT.has(helper)) expect(enqueuers, helper).toContain(helper);
    }
  });

  it('only src/lib/partner-support-settings.ts is excused from enqueuing itself (R2-Q3 G2)', () => {
    expect([...INDIRECT]).toEqual(['src/lib/partner-support-settings.ts']);
    const helperFns = (self: string) => Object.entries(HELPERS).filter(([rel]) => rel !== self).flatMap(([, fns]) => fns);
    for (const helper of INDIRECT) {
      expect(Object.keys(HELPERS), helper).toContain(helper);
      // A member that enqueues itself again leaves the set (the check above then covers it).
      expect(enqueuers, helper).not.toContain(helper);
      const text = files.find((f) => f.rel === helper)?.text ?? '';
      // It really reaches the outbox through a listed function of ANOTHER helper.
      expect(
        helperFns(helper).some((fn) => new RegExp(`\\b${fn}\\(`).test(text)),
        helper,
      ).toBe(true);
    }
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
