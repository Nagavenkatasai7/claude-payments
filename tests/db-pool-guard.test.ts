import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';
import type { EventEmitter } from 'node:events';

// Weekly reliability check 2026-11-09, item 1: a dropped IDLE Neon connection
// printed the full DATABASE_URL (with the password) into the Vercel logs on
// 2026-10-17 and again on 2026-11-09.
//
// Cause, in @neondatabase/serverless v1.1.0 (node_modules/.../index.mjs):
//  - :1088-1089  the Pool's idle listener sets `err.client = client`, then
//                emits 'error' on the Pool;
//  - :1115       the Pool builds each client with its own options object;
//  - :1308       the client keeps that object as `config`, and the options
//                hold `connectionString`.
// With no 'error' listener on the Pool the emit THROWS (Node's EventEmitter
// rule), the exception is uncaught, and Node prints the whole error object:
// err -> client -> config -> connectionString.
//
// These tests run the REAL driver classes through getDb(). Nothing connects: a
// Pool dials only on its first query.

const h = vi.hoisted(() => {
  const canary = 'pw-Zx9-leak-canary';
  return {
    canary,
    dbUrl: `postgres://neondb_owner:${canary}@ep-test-123.invalid/neondb?sslmode=require`,
  };
});
vi.mock('@/lib/env', () => ({ env: { databaseUrl: h.dbUrl } }));

import { getDb } from '@/db/client';
import { dbErrorFields, redactorFor } from '@/db/pool-guard';

type DriverClient = EventEmitter & {
  password: string;
  connectionParameters: { host: string; user: string; database: string };
};
type DriverPool = EventEmitter & {
  options: { connectionString?: string };
  Client: new (options: unknown) => DriverClient;
};

const pool = () => getDb().$client as unknown as DriverPool;

/** A real driver client, built the way the Pool builds one (index.mjs:1115). It never connects. */
const newClient = () => new (pool().Client)(pool().options);

const TERMINATED = 'Connection terminated unexpectedly';

/**
 * A real idle drop, in the driver's order. The guard's client listener went on
 * at 'connect' and the Pool re-adds its idle listener at each release
 * (index.mjs:1120-1126), so the guard's listener runs FIRST. Then the idle
 * listener hangs the client on the error and forwards it to the Pool
 * (:1088-1089); the `once` below stands in for it.
 */
function dropIdle(client: DriverClient, message = TERMINATED): Error {
  const err = new Error(message);
  pool().emit('connect', client);
  client.once('error', (e: Error) => {
    Object.assign(e, { client });
    pool().emit('error', e, client);
  });
  client.emit('error', err);
  return err;
}

const printed = (value: unknown) => inspect(value, { depth: Infinity, showHidden: false });

describe('db/client: a dropped connection never prints the database password', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const lines = () => errorSpy.mock.calls.map((args: unknown[]) => args.map(String).join(' '));

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('a dropped idle connection does not throw out of the Pool (no uncaught exception)', () => {
    expect(() => dropIdle(newClient())).not.toThrow();
  });

  it('logs ONE line for a dropped idle connection, with no connection string and no password', () => {
    dropIdle(newClient());
    expect(lines()).toHaveLength(1);
    const line = JSON.parse(lines()[0]) as Record<string, string>;
    expect(line.level).toBe('error');
    expect(line.scope).toBe('db.pool');
    expect(line.name).toBe('Error');
    expect(line.detail).toBe(TERMINATED);
    expect(lines()[0]).not.toContain(h.canary);
    expect(lines()[0]).not.toContain('postgres://');
  });

  it('redacts a URL that rides inside the driver error message', () => {
    dropIdle(newClient(), `connect failed for ${h.dbUrl} (ECONNRESET)`);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).not.toContain(h.canary);
    expect(lines()[0]).not.toContain('neondb_owner');
    expect(lines()[0]).toContain('ECONNRESET');
  });

  it('the dropped-connection error prints in full without the password', () => {
    const err = dropIdle(newClient());
    expect(printed(err)).not.toContain(h.canary);
  });

  it('a driver client and the Pool print in full without the password', () => {
    // Defense in depth: even an error path that this file does not know about
    // (a future console.error(client), an error that carries the Pool) cannot
    // print the connection string.
    expect(printed(newClient())).not.toContain(h.canary);
    expect(printed(pool())).not.toContain(h.canary);
  });

  it('the driver still reads the hidden connection string', () => {
    expect(pool().options.connectionString).toBe(h.dbUrl);
    const client = newClient();
    expect(client.connectionParameters.host).toBe('ep-test-123.invalid');
    expect(client.connectionParameters.user).toBe('neondb_owner');
    expect(client.connectionParameters.database).toBe('neondb');
    expect(client.password).toBe(h.canary);
  });

  it('a connection that drops while a transaction holds it does not throw either', () => {
    // A checked-out client has no idle listener (the Pool removes it on
    // acquire), so its 'error' event had no listener at all: the emit threw and
    // the exception was uncaught. The in-flight query still rejects with the
    // same error, so the request fails in the normal way.
    const client = newClient();
    pool().emit('connect', client);
    expect(() => client.emit('error', new Error(TERMINATED))).not.toThrow();
    expect(lines()).toHaveLength(1);
    expect((JSON.parse(lines()[0]) as Record<string, string>).scope).toBe('db.pool');
  });

  it('drops the client reference that the idle listener hangs on the error', () => {
    expect('client' in dropIdle(newClient())).toBe(false);
  });

  it('never throws out of the listener, even when the client reference cannot be deleted', () => {
    // A throw inside an 'error' listener is the same uncaught exception again.
    const err = new Error(TERMINATED);
    Object.defineProperty(err, 'client', { value: newClient(), enumerable: true, configurable: false });
    expect(() => pool().emit('error', err, null)).not.toThrow();
    expect(lines()).toHaveLength(1);
    expect(printed(err)).not.toContain(h.canary);
  });

  it('a query that waits on the dropped connection still rejects with the same error', async () => {
    // The client listener must not hide the failure from the request: the
    // driver rejects every queued query before it emits 'error'
    // (_handleErrorEvent -> _errorAllQueries, index.mjs:1043).
    const client = newClient() as DriverClient & {
      query(text: string): Promise<unknown>;
      _handleErrorEvent(err: Error): void;
    };
    pool().emit('connect', client);
    const pending = client.query('select 1');
    const err = new Error(TERMINATED);
    expect(() => client._handleErrorEvent(err)).not.toThrow();
    await expect(pending).rejects.toBe(err);
  });

  it('logs one line, not two, when the client and the Pool both report the same error', () => {
    const client = newClient();
    pool().emit('connect', client);
    const err = Object.assign(new Error(TERMINATED), { client });
    client.emit('error', err); // the client listener sees it first
    pool().emit('error', err, client); // then the idle listener forwards it to the Pool
    expect(lines()).toHaveLength(1);
  });
});

describe('pool-guard helpers', () => {
  it('redactorFor masks every URL, and a bare copy of the password (raw or decoded)', () => {
    const redact = redactorFor('postgres://owner:p%40ss-w0rd@ep-x.invalid/db');
    expect(redact('dial wss://ep-x.invalid/v2 failed')).toBe('dial <url> failed');
    expect(redact('auth failed, tried p%40ss-w0rd')).toBe('auth failed, tried <redacted>');
    expect(redact('auth failed, tried p@ss-w0rd')).toBe('auth failed, tried <redacted>');
    expect(redact('Connection terminated unexpectedly')).toBe('Connection terminated unexpectedly');
  });

  it('redactorFor matches the percent-encoded password in any letter case', () => {
    const redact = redactorFor('postgres://owner:p%40ss%2Fw0rd@ep-x.invalid/db');
    expect(redact('tried p%40ss%2fw0rd')).toBe('tried <redacted>');
    expect(redact('tried P%40SS%2FW0RD')).toBe('tried <redacted>');
    expect(redact('tried p@ss/w0rd')).toBe('tried <redacted>');
  });

  it('redactorFor masks the raw password even when its percent-escape is malformed', () => {
    // decodeURIComponent throws on these; the raw password must already be in the set.
    for (const pw of ['abcd%zzefgh', 'abcd%E0%A4%A', 'abcd%']) {
      const redact = redactorFor(`postgres://owner:${pw}@ep-x.invalid/db`);
      expect(redact(`server said ${pw}`)).toBe('server said <redacted>');
    }
  });

  it('redactorFor still masks URLs when there is no usable connection string', () => {
    expect(redactorFor(undefined)('see postgres://u:pw@h/db now')).toBe('see <url> now');
    expect(redactorFor('not a url')('see postgres://u:pw@h/db now')).toBe('see <url> now');
  });

  it('dbErrorFields takes the name, the code and the redacted message, never the object', () => {
    const err = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
      client: { config: { connectionString: h.dbUrl } },
    });
    expect(dbErrorFields(err)).toEqual({
      name: 'Error',
      code: '57P01',
      detail: 'terminating connection due to administrator command',
    });
    expect(dbErrorFields('plain string')).toEqual({ name: 'UnknownError', detail: 'plain string' });
    expect(dbErrorFields(undefined)).toEqual({ name: 'UnknownError' });
  });
});
