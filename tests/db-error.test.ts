import { describe, it, expect, beforeAll } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { sql } from 'drizzle-orm';
import { isQueryError, stripQueryParams, queryErrorText, sqlState } from '@/lib/db-error';
import { sellers } from '@/db/schema';
import { freshDb } from './helpers-db';

// Fake values only. Every assertion below is about their ABSENCE.
const PHONE = '+15551234567';
const NAME = 'Ravi Traders';
const EMAIL = 'jane@example.com';
const DETAIL = 'Key (phone)=(+15551234567) already exists.';
const FAKES = [PHONE, '15551234567', NAME, EMAIL, DETAIL, 'already exists'];

function fakeCause() {
  return Object.assign(new Error('duplicate key value violates unique constraint "customers_phone_key"'), {
    code: '23505',
    detail: DETAIL,
    where: `SQL statement with ${NAME}`,
    hint: `try ${EMAIL}`,
    constraint: 'customers_phone_key',
    table: 'customers',
  });
}

function fakeQueryError(cause: Error | null = fakeCause()) {
  return new DrizzleQueryError(
    'insert into "customers" ("phone", "name", "email") values ($1, $2, $3)',
    [PHONE, NAME, EMAIL],
    cause ?? undefined,
  );
}

function expectNoFakes(text: string) {
  for (const v of FAKES) expect(text).not.toContain(v);
  expect(text).not.toMatch(/params: \[/);
  expect(text).not.toMatch(/params: (?!<redacted>)/);
}

// The real drizzle 0.45.3 shape: a PGlite unique violation and a missing table.
let realUnique: unknown;
let realMissing: unknown;
let realData: unknown;
beforeAll(async () => {
  const db = await freshDb();
  const row = { id: 'sel_1', partnerId: 'default', phone: '15551234567', businessName: NAME, country: 'IN', currency: 'INR' };
  await db.insert(sellers).values(row);
  realUnique = await db.insert(sellers).values({ ...row, id: 'sel_2' }).then(() => null, (e: unknown) => e);
  realMissing = await db
    .execute(sql`select * from no_such_table where phone = ${PHONE}`)
    .then(() => null, (e: unknown) => e);
  realData = await db.execute(sql`select ${NAME}::int`).then(() => null, (e: unknown) => e);
});

describe('isQueryError', () => {
  it('knows a DrizzleQueryError, a Failed-query Error and a real PGlite failure', () => {
    expect(isQueryError(fakeQueryError())).toBe(true);
    expect(isQueryError(new Error('Failed query: select 1\nparams: '))).toBe(true);
    expect(isQueryError({ query: 'select 1', params: [] })).toBe(true);
    expect(realUnique).toBeInstanceOf(DrizzleQueryError);
    expect(isQueryError(realUnique)).toBe(true);
    expect(isQueryError(realMissing)).toBe(true);
  });

  it('says no to other errors and to non-objects', () => {
    expect(isQueryError(new Error('boom'))).toBe(false);
    expect(isQueryError({ query: 'select 1' })).toBe(false);
    expect(isQueryError('Failed query: select 1')).toBe(false);
    expect(isQueryError(null)).toBe(false);
    expect(isQueryError(undefined)).toBe(false);
    expect(isQueryError(42)).toBe(false);
  });
});

describe('stripQueryParams', () => {
  const msg = fakeQueryError().message;

  it('cuts the params after a real newline', () => {
    expect(msg).toContain(PHONE); // the drizzle message really holds them
    const out = stripQueryParams(msg);
    expect(out).toBe(
      'Failed query: insert into "customers" ("phone", "name", "email") values ($1, $2, $3)\nparams: <redacted>',
    );
  });

  it('cuts the params after a JSON-escaped newline, to the end of the text', () => {
    const json = JSON.stringify({ note: msg, after: 'tail' });
    const out = stripQueryParams(json);
    expectNoFakes(out);
    expect(out).toContain('\\nparams: <redacted>');
    expect(out).not.toContain('tail');
  });

  it('cuts the params after a plain space (synthetic messages in tests)', () => {
    expect(stripQueryParams(`Failed query: insert into outbox params: ${JSON.stringify({ to: PHONE })}`)).toBe(
      'Failed query: insert into outbox params: <redacted>',
    );
  });

  it('cuts the params when the message follows a prefix', () => {
    const out = stripQueryParams(`worker: ${msg}`);
    expect(out.startsWith('worker: Failed query: insert')).toBe(true);
    expectNoFakes(out);
  });

  it('leaves text without the marker unchanged', () => {
    const t = `params: ${PHONE} and more`;
    expect(stripQueryParams(t)).toBe(t);
    expect(stripQueryParams('')).toBe('');
  });

  it('is idempotent', () => {
    const once = stripQueryParams(msg);
    expect(stripQueryParams(once)).toBe(once);
    const j = stripQueryParams(JSON.stringify({ note: msg }));
    expect(stripQueryParams(j)).toBe(j);
  });
});

describe('sqlState', () => {
  it('reads the SQLSTATE of the cause, or of a bare driver error', () => {
    expect(sqlState(fakeQueryError())).toBe('23505');
    expect(sqlState(fakeCause())).toBe('23505');
    expect(sqlState(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBeUndefined();
    expect(sqlState(null)).toBeUndefined();
    expect(sqlState(realUnique)).toBe('23505');
  });
});

describe('queryErrorText', () => {
  it('keeps the SQLSTATE, the reason, the ids and the SQL head; drops params and detail', () => {
    const out = queryErrorText(fakeQueryError());
    expect(out).toBe(
      'db query failed [23505] duplicate key value violates unique constraint "customers_phone_key"' +
        ' constraint=customers_phone_key table=customers' +
        ' | query: insert into "customers" ("phone", "name", "email") values ($1, $2, $3) | params: <redacted>',
    );
    expectNoFakes(out);
  });

  it('describes the real PGlite unique violation without the phone or the business name', () => {
    const out = queryErrorText(realUnique);
    expect(out).toContain('[23505]');
    expect(out).toContain('constraint=sellers_partner_phone');
    expect(out).toContain('table=sellers');
    expect(out).toContain('| query: insert into "sellers"');
    expectNoFakes(out);
  });

  it('describes the real missing-table failure without the bound phone', () => {
    const out = queryErrorText(realMissing);
    expect(out).toContain('[42P01] relation "no_such_table" does not exist');
    expectNoFakes(out);
  });

  it('hides the class-22 reason, which echoes the value', () => {
    const real = queryErrorText(realData);
    expect(real).toContain('[22P02] data exception (value hidden)');
    expectNoFakes(real);
    const cause = Object.assign(new Error(`invalid input syntax for type integer: "${NAME}"`), { code: '22P02' });
    expect(queryErrorText(fakeQueryError(cause))).toContain('[22P02] data exception (value hidden) |');
  });

  it('drops ids that do not look like identifiers', () => {
    const cause = Object.assign(fakeCause(), { constraint: `x ${NAME}`, column: 'phone' });
    const out = queryErrorText(fakeQueryError(cause));
    expect(out).not.toContain('constraint=');
    expect(out).toContain(' table=customers column=phone |');
  });

  it('cuts a long SQL text at 300 characters', () => {
    const long = `select ${'"c", '.repeat(200)}"z" from t where p = $1`;
    const out = queryErrorText(new DrizzleQueryError(long, [PHONE], fakeCause()));
    const head = out.split(' | query: ')[1].split(' | params:')[0];
    expect(head.length).toBe(301);
    expect(head.endsWith('…')).toBe(true);
  });

  it('works with no cause, a nameless cause and a message-only error', () => {
    expect(queryErrorText(fakeQueryError(null))).toBe(
      'db query failed [no SQLSTATE] unknown cause | query: insert into "customers" ("phone", "name", "email") values ($1, $2, $3) | params: <redacted>',
    );
    const noMessage = Object.assign(new Error(''), { name: 'NeonDbError' });
    expect(queryErrorText(fakeQueryError(noMessage))).toContain('[no SQLSTATE] NeonDbError |');
    const bare = new Error(`Failed query: select * from t where p = $1\nparams: ${PHONE}`);
    const out = queryErrorText(bare);
    expect(out).toBe('db query failed [no SQLSTATE] unknown cause | query: select * from t where p = $1 | params: <redacted>');
  });

  it('never throws, whatever it is given', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(PHONE);
        },
        has() {
          throw new Error(PHONE);
        },
      },
    );
    for (const v of [undefined, null, 42, 'Failed query: x', Symbol('s'), hostile, { cause: 7 }]) {
      const out = queryErrorText(v);
      expect(out.startsWith('db query failed [no SQLSTATE]')).toBe(true);
      expectNoFakes(out);
    }
  });
});
