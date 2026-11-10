import { describe, it, expect, beforeAll } from 'vitest';
import util from 'node:util';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { sellers } from '@/db/schema';
import { guardQueryErrors } from '@/db/query-error-guard';
import { freshDb } from './helpers-db';

// 2026-11-10: Next prints every uncaught error itself with console.error(err)
// (node_modules/next/dist/server/route-modules/route-module.js:320-333), and a
// raw `console.warn('label', err)` does the same. Both go through util.inspect
// (console.error passes its arguments to util.format, which inspects objects:
// node_modules/@types/node/console.d.ts:165-186, util.d.ts:233-245). For a
// DrizzleQueryError that print shows the message with the params, the own
// `params` array and the `[cause]` with the Postgres `detail`. The guard gives
// the class a util.inspect.custom (util.d.ts:637, `inspect.custom`; the hook is
// skipped only when `customInspect: false`, util.d.ts:31-35) that prints the
// fixed description and the stack frames only.

const PHONE = '+15551234567';
const NAME = 'Ravi Traders';
const EMAIL = 'jane@example.com';
const DETAIL = 'Key (phone)=(+15551234567) already exists.';
const FAKES = [PHONE, '15551234567', NAME, EMAIL, DETAIL, 'already exists'];

function queryError() {
  const cause = Object.assign(new Error('duplicate key value violates unique constraint "customers_phone_key"'), {
    code: '23505',
    detail: DETAIL,
    constraint: 'customers_phone_key',
    table: 'customers',
  });
  return new DrizzleQueryError(
    'insert into "customers" ("phone", "name", "email") values ($1, $2, $3)',
    [PHONE, NAME, EMAIL],
    cause,
  );
}

function expectSafe(text: string) {
  for (const v of FAKES) expect(text).not.toContain(v);
  expect(text).not.toContain('params: [');
  expect(text).not.toMatch(/params: (?!<redacted>)/);
  expect(text).toContain('DrizzleQueryError: db query failed [23505]');
  expect(text).toMatch(/\n\s+at /); // stack frames stay
}

/** What console.warn('label', value) writes, through a real node:console Console. */
function consoleWarnText(...args: unknown[]): string {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, done) {
      out += String(chunk);
      done();
    },
  });
  new Console({ stdout: sink, stderr: sink, colorMode: false }).warn(...args);
  return out;
}

let realUnique: unknown;
beforeAll(async () => {
  guardQueryErrors();
  const db = await freshDb();
  const row = { id: 'sel_1', partnerId: 'default', phone: '15551234567', businessName: NAME, country: 'IN', currency: 'INR' };
  await db.insert(sellers).values(row);
  realUnique = await db.insert(sellers).values({ ...row, id: 'sel_2' }).then(() => null, (e: unknown) => e);
});

describe('guardQueryErrors: printing a query error never shows params or detail', () => {
  it('util.inspect of the error, nested in an object, in an array and as a cause', () => {
    const err = queryError();
    expectSafe(util.inspect(err));
    expectSafe(util.inspect(err, { depth: Infinity, showHidden: true }));
    expectSafe(util.inspect({ nested: err }));
    expectSafe(util.inspect([err]));
    expectSafe(util.inspect(new Error('outer', { cause: err })));
  });

  it('util.format with %o and console.warn("label", err)', () => {
    const err = queryError();
    expectSafe(util.format('%s %o', 'label', err));
    const warned = consoleWarnText('label', err);
    expect(warned.startsWith('label DrizzleQueryError:')).toBe(true);
    expectSafe(warned);
    expectSafe(consoleWarnText(err));
  });

  it('the stack header (which repeats the message with params) is not printed', () => {
    const err = queryError();
    expect(err.stack).toContain(PHONE); // the raw stack does hold it
    const lines = util.inspect(err).split('\n');
    expect(lines[0]).toMatch(/^DrizzleQueryError: db query failed/);
    expect(lines.slice(1).every((l) => /^\s+at /.test(l))).toBe(true);
  });

  it('covers the real PGlite unique violation', () => {
    expect(realUnique).toBeInstanceOf(DrizzleQueryError);
    const out = util.inspect(realUnique);
    expectSafe(out);
    expect(out).toContain('constraint=sellers_partner_phone');
    expectSafe(consoleWarnText('label', realUnique));
  });

  it('is idempotent and never throws', () => {
    expect(() => guardQueryErrors()).not.toThrow();
    expect(() => guardQueryErrors()).not.toThrow();
    expectSafe(util.inspect(queryError()));
    const desc = Object.getOwnPropertyDescriptor(DrizzleQueryError.prototype, util.inspect.custom);
    expect(desc?.enumerable).toBe(false);
  });

  // Review 2026-11-10 (L4): when the message changed after the stack was
  // taken, the header cannot be cut off exactly, and a line of the params can
  // look like a frame. Then no frame is printed at all.
  it('prints no frames when the stack header cannot be found', () => {
    const err = queryError();
    err.stack = `Error: Failed query: select 1\nparams: x\n    at ${NAME} (${PHONE})\n    at real (file.ts:1:1)`;
    const out = util.inspect(err);
    for (const v of FAKES) expect(out).not.toContain(v);
    expect(out).toMatch(/^DrizzleQueryError: db query failed \[23505\]/);
    expect(out).not.toContain('\n');
  });

  it('does not change String(err) or err.message: those go through scrub()', () => {
    const err = queryError();
    expect(err.message).toContain(`params: ${PHONE},${NAME},${EMAIL}`);
    expect(String(err)).toContain(PHONE);
  });
});
