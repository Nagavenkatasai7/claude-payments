// Review R2-Q1 B4: the confirmation code's single-use GETDEL runs on a no-retry client
// (transaction-otp.ts, R1-P4 B2), so a network error there throws out of verify(). Its shape
// varies (a bare TypeError('fetch failed') with no cause code is not an isInfraError shape), so
// verify marks the thrown error here and every caller of verify maps a marked error to its
// retryable answer (the pay routes: 503 temporarily_unavailable), never "wrong code".
//
// A module of its own, with no imports, so route tests that vi.mock('@/lib/transaction-otp')
// with a factory keep working. The mark is a WeakSet entry: the error keeps its own name and
// message (the routes already log it through the scrubbing logger) and nothing is added to it.

// One set per process (globalThis, Symbol.for), so a second copy of this module (a bundler
// chunk, a test's vi.resetModules) still sees the marks.
const REGISTRY = Symbol.for('smartremit.otpConsumeFailures');
const g = globalThis as { [REGISTRY]?: WeakSet<object> };
const failures: WeakSet<object> = (g[REGISTRY] ??= new WeakSet<object>());

/** Marks a consume failure and returns the value to throw. A non-object throw becomes a fixed Error. */
export function markOtpConsumeFailure(err: unknown): object {
  const e = typeof err === 'object' && err !== null ? err : new Error('confirmation code consume failed');
  failures.add(e);
  return e;
}

/** Whether `err` is a marked consume failure (retryable: the code was neither accepted nor refused). */
export function isOtpConsumeFailure(err: unknown): boolean {
  return typeof err === 'object' && err !== null && failures.has(err);
}
