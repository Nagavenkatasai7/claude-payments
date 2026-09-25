import { describe, it, expect } from 'vitest';
import { isInfraError } from '@/lib/infra-error';

// R1: the inbound webhook returns 500 (Meta retries) ONLY for infrastructure
// errors. Everything else is acknowledged, so one bad payload can never make
// Meta retry for days. This is an ALLOWLIST: unknown ⇒ not infra.

const withCode = (code: string, message = 'x', name = 'Error') =>
  Object.assign(new Error(message), { code, name });

/** drizzle 0.45 wraps the driver error: DrizzleQueryError.cause (node_modules/drizzle-orm/errors.d.ts:9-14). */
const wrapped = (cause: Error) =>
  Object.assign(new Error('Failed query: insert into "outbox" ...'), { name: 'DrizzleQueryError', cause });

describe('isInfraError — infrastructure errors (⇒ 500, Meta retries)', () => {
  it.each([
    ['08006 connection failure', '08006'],
    ['08001 cannot connect', '08001'],
    ['53300 too many connections', '53300'],
    ['53100 disk full', '53100'],
    ['57P01 admin shutdown', '57P01'],
    ['57P02 crash shutdown', '57P02'],
    ['57P03 cannot connect now', '57P03'],
    ['57014 statement timeout', '57014'],
    ['40001 serialization failure', '40001'],
    ['40P01 deadlock', '40P01'],
  ])('SQLSTATE %s', (_label, code) => {
    expect(isInfraError(withCode(code))).toBe(true);
    expect(isInfraError(wrapped(withCode(code)))).toBe(true);
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])(
    'network code %s (also as the cause of a fetch TypeError)',
    (code) => {
      expect(isInfraError(withCode(code))).toBe(true);
      const fetchFailed = new TypeError('fetch failed', { cause: withCode(code) });
      expect(isInfraError(fetchFailed)).toBe(true);
    },
  );

  it.each([
    'timeout exceeded when trying to connect',
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'Client has encountered a connection error and is not queryable',
    'Exhausted all retries',
    'Your project has exceeded the compute time quota. Upgrade your plan to increase limits.',
  ])('message: %s', (message) => {
    expect(isInfraError(new Error(message))).toBe(true);
    expect(isInfraError(wrapped(new Error(message)))).toBe(true);
  });

  // Sourced from the installed drivers: @neondatabase/serverless 1.1.0 index.js
  // ("Client was closed and is not queryable", "Query read timeout", "There was
  // an error establishing an SSL connection") and ws lib/websocket.js:305/:495/:933.
  it.each([
    'Client was closed and is not queryable',
    'Query read timeout',
    'There was an error establishing an SSL connection',
    'WebSocket was closed before the connection was established',
    'Unexpected server response: 502',
    'WebSocket is not open: readyState 0 (CONNECTING)',
  ])('driver message: %s', (message) => {
    expect(isInfraError(new Error(message))).toBe(true);
  });

  it('a ws ErrorEvent (neon re-emits the socket event): the real error sits on `.error`, not `.cause`', () => {
    // ws lib/event-target.js:118-133 — ErrorEvent { error, message } with no `name`/`code` of its own.
    const errorEvent = { type: 'error', message: '', error: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) };
    expect(isInfraError(errorEvent)).toBe(true);
    expect(isInfraError(wrapped(errorEvent as unknown as Error))).toBe(true);
  });

  it('a TimeoutError / AbortError (AbortSignal.timeout)', () => {
    expect(isInfraError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe(true);
    expect(isInfraError(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))).toBe(true);
  });

  it('Upstash: a non-JSON gateway body, or a request-limit error', () => {
    expect(isInfraError(Object.assign(new Error('<html>502</html>'), { name: 'UpstashJSONParseError' }))).toBe(true);
    expect(isInfraError(Object.assign(new Error('ERR max requests limit exceeded. Limit: 10000, Usage: 10000, command was: ["get"]'), { name: 'UpstashError' }))).toBe(true);
  });
});

describe('isInfraError — everything else (⇒ acknowledged + audited)', () => {
  it.each([
    ['22P05 null byte in jsonb (a poison body)', '22P05'],
    ['22021 invalid byte sequence', '22021'],
    ['23502 not-null violation', '23502'],
    ['23505 unique violation', '23505'],
    ['42703 undefined column', '42703'],
  ])('SQLSTATE %s', (_label, code) => {
    expect(isInfraError(withCode(code))).toBe(false);
    expect(isInfraError(wrapped(withCode(code)))).toBe(false);
  });

  it('a plain code bug (TypeError without a network cause)', () => {
    expect(isInfraError(new TypeError("Cannot read properties of undefined (reading 'from')"))).toBe(false);
  });

  it('an Upstash command error (WRONGTYPE)', () => {
    expect(isInfraError(Object.assign(new Error('WRONGTYPE Operation against a key holding the wrong kind of value, command was: ["get"]'), { name: 'UpstashError' }))).toBe(false);
  });

  it('non-Error values', () => {
    expect(isInfraError(undefined)).toBe(false);
    expect(isInfraError(null)).toBe(false);
    expect(isInfraError('db down')).toBe(false);
    expect(isInfraError({ code: 'not-a-code' })).toBe(false);
  });

  it('a throwing getter never escapes', () => {
    const hostile = Object.defineProperty({}, 'code', { get() { throw new Error('boom'); } });
    expect(isInfraError(hostile)).toBe(false);
  });

  it('a self-referencing cause chain terminates', () => {
    const e = new Error('loop') as Error & { cause?: unknown };
    e.cause = e;
    expect(isInfraError(e)).toBe(false);
  });
});
