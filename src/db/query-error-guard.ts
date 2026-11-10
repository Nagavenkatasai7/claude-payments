import { DrizzleQueryError } from 'drizzle-orm/errors';
import { queryErrorText } from '@/lib/db-error';
import { scrub } from '@/lib/log';

// query-error-guard — printing a drizzle query error must not print the
// customer data it carries.
//
// A DrizzleQueryError (node_modules/drizzle-orm/errors.js:10-20, 0.45.3) has
// the message `Failed query: <sql>\nparams: <values>`, the own properties
// `query`, `params` and `cause`, and a cause whose `detail` echoes key values.
// Node's console.* passes objects to util.inspect (node_modules/@types/node/
// console.d.ts:165-186), and util.inspect prints the stack (whose header
// repeats the message), every own property and the `[cause]`. Next prints each
// uncaught error that way itself (node_modules/next/dist/server/route-modules/
// route-module.js:320-333), before our onRequestError runs.
//
// The guard gives the class a util.inspect.custom hook (the symbol is
// `Symbol.for('nodejs.util.inspect.custom')`, @types/node/util.d.ts:637).
// util.inspect calls it for the error itself and wherever it is nested (an
// object, an array, the cause of another error), so every print shows the
// fixed description from src/lib/db-error.ts plus the stack frames. Same idea
// as hideConnectionString in ./pool-guard.
//
// What it does NOT change: `err.message`, `String(err)` and `err.stack`. Code
// that logs those goes through scrub() (src/lib/log.ts), which cuts the params.

const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const FRAME = /^\s+at /;

/** The stack frames, never the header (which repeats the message with the params). */
function framesOf(err: Error): string[] {
  const stack = typeof err.stack === 'string' ? err.stack : '';
  const header = `${err.name}: ${err.message}`;
  if (stack.startsWith(header)) {
    return stack.slice(header.length).split('\n').filter((l) => FRAME.test(l));
  }
  // The message changed after the stack was taken: the header cannot be found,
  // so every frame-looking line also goes through the scrubber.
  return stack.split('\n').filter((l) => FRAME.test(l)).map((l) => scrub(l));
}

function inspectQueryError(this: Error): string {
  try {
    return [`DrizzleQueryError: ${scrub(queryErrorText(this))}`, ...framesOf(this)].join('\n');
  } catch {
    return 'DrizzleQueryError: db query failed (description unavailable)';
  }
}

/** Gives DrizzleQueryError a safe util.inspect. Idempotent; never throws. Call once at startup. */
export function guardQueryErrors(): void {
  try {
    const proto = DrizzleQueryError.prototype as unknown as Record<symbol, unknown>;
    if (proto[INSPECT] === inspectQueryError) return;
    Object.defineProperty(proto, INSPECT, {
      value: inspectQueryError,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // A frozen prototype: nothing safe left to do. The logger still scrubs.
  }
}
