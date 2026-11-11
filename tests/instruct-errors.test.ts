import { describe, it, expect } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import {
  ComplianceBlockUnavailableError,
  INSTRUCT_FUNDING_MODE_DEFER_SEC,
  INSTRUCT_TRAVEL_RULE_DEFER_SEC,
  InstructFundingModeError,
  InstructPermanentError,
  InstructTravelRuleError,
  RailRecordError,
  isTransientInstructError,
  railRecordAlertKey,
} from '@/lib/instruct-errors';
import { ComplianceBlockUnavailableError as ReExported } from '@/lib/instruction-compliance';
import { RailInstructError } from '@/lib/outbox-worker';

// Fix pack 5 T4 (P7, P11): the instruct error classes and the allow-list
// classifier that tells a transient error (database, network, timeout) from
// anything else. Shapes copied from tests/db-error.test.ts (fake values only).

function fakeCause() {
  return Object.assign(new Error('duplicate key value violates unique constraint "customers_phone_key"'), {
    code: '23505',
    detail: 'Key (phone)=(+15551234567) already exists.',
    table: 'customers',
  });
}
const withCode = (code: string) => Object.assign(new Error(`connect ${code}`), { code });

describe('isTransientInstructError (P7 allow-list)', () => {
  it('a drizzle query error and a bare driver error (SQLSTATE + severity) are transient', () => {
    expect(isTransientInstructError(new DrizzleQueryError('select 1', ['x'], fakeCause()))).toBe(true);
    expect(isTransientInstructError(new Error('Failed query: select 1\nparams: '))).toBe(true);
    expect(isTransientInstructError(Object.assign(fakeCause(), { severity: 'ERROR' }))).toBe(true);
  });

  it('AbortError, TimeoutError, the network codes and fetch failed are transient', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isTransientInstructError(abort)).toBe(true);
    const signal = AbortSignal.timeout(1);
    await new Promise((r) => setTimeout(r, 20));
    expect((signal.reason as Error).name).toBe('TimeoutError');
    expect(isTransientInstructError(signal.reason)).toBe(true);
    for (const c of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']) {
      expect(isTransientInstructError(withCode(c))).toBe(true);
    }
    expect(isTransientInstructError(new TypeError('fetch failed'))).toBe(true);
  });

  it("the Neon pool's connection errors are transient (no SQLSTATE, not wrapped by drizzle)", () => {
    expect(isTransientInstructError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isTransientInstructError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(
      isTransientInstructError(new Error('Connection terminated due to connection timeout', { cause: new Error('x') })),
    ).toBe(true);
    const neon = new Error('db down');
    neon.name = 'NeonDbError';
    expect(isTransientInstructError(neon)).toBe(true);
    expect(isTransientInstructError(new Error('wrapped', { cause: new Error('timeout exceeded when trying to connect') }))).toBe(true);
    expect(isTransientInstructError(new Error('wrapped', { cause: withCode('ECONNRESET') }))).toBe(true);
    // A WebSocket ErrorEvent (the Neon socket's error event), by its constructor name.
    class ErrorEvent {
      readonly type = 'error';
    }
    expect(isTransientInstructError(new ErrorEvent())).toBe(true);
  });

  it('everything else is NOT transient', () => {
    expect(isTransientInstructError(new Error('decrypt failed'))).toBe(false);
    expect(isTransientInstructError(new Error('Unsupported state or unable to authenticate data'))).toBe(false);
    expect(isTransientInstructError(new TypeError('x is undefined'))).toBe(false);
    expect(isTransientInstructError('timeout exceeded when trying to connect')).toBe(false);
    expect(isTransientInstructError(null)).toBe(false);
    expect(isTransientInstructError(undefined)).toBe(false);
    expect(isTransientInstructError(new InstructPermanentError('t1', 'build'))).toBe(false);
    expect(isTransientInstructError(new RailInstructError('railp', 'Settlement instruction rejected (503)'))).toBe(false);
    // the cause is followed ONE level only
    const deep = new Error('a', { cause: new Error('b', { cause: withCode('ECONNRESET') }) });
    expect(isTransientInstructError(deep)).toBe(false);
  });

  it('never throws, even on a hostile object', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        getPrototypeOf() {
          throw new Error('boom');
        },
      },
    );
    expect(isTransientInstructError(hostile)).toBe(false);
    expect(isTransientInstructError(42)).toBe(false);
  });
});

describe('railRecordAlertKey (P30)', () => {
  it('is railrecord:<hour>; two instants in the same hour share it', () => {
    const H = 3_600_000;
    const base = Math.floor(Date.now() / H) * H;
    expect(railRecordAlertKey(base)).toBe(`railrecord:${base / H}`);
    expect(railRecordAlertKey(base + H - 1)).toBe(railRecordAlertKey(base + 1));
    expect(railRecordAlertKey(base + H)).not.toBe(railRecordAlertKey(base));
    expect(railRecordAlertKey()).toBe(`railrecord:${Math.floor(Date.now() / H)}`);
  });
});

describe('the instruct error classes (P7)', () => {
  it('each class has its name, an ids-and-codes-only message, and the agreed delays', () => {
    const cause = new Error('inner');
    const p = new InstructPermanentError('t1', 'build', { cause });
    expect(p).toBeInstanceOf(Error);
    expect(p.name).toBe('InstructPermanentError');
    expect(p.message).toBe('instruct_permanent:build:t1');
    expect(p.transferId).toBe('t1');
    expect(p.code).toBe('build');
    expect(p.cause).toBe(cause);
    expect(new InstructPermanentError('t2', 'decrypt').message).toBe('instruct_permanent:decrypt:t2');
    expect(new InstructPermanentError('t3', 'compliance_block').message).toBe('instruct_permanent:compliance_block:t3');

    const c = new ComplianceBlockUnavailableError('t1', 'railp');
    expect(c.name).toBe('ComplianceBlockUnavailableError');
    expect(c.message).toBe('compliance_block_unavailable:t1');
    expect(c.transferId).toBe('t1');
    expect(c.railPartnerId).toBe('railp');
    expect(ReExported).toBe(ComplianceBlockUnavailableError);

    const r = new RailRecordError('t1');
    expect(r.name).toBe('RailRecordError');
    expect(r.message).toBe('rail_record_failed:t1');
    expect(r.transferId).toBe('t1');
    expect(r instanceof RailInstructError).toBe(false);

    expect(INSTRUCT_FUNDING_MODE_DEFER_SEC).toBe(900);
    const f = new InstructFundingModeError();
    expect(f.delaySec).toBe(900);
    expect(f.name).toBe('InstructFundingModeError');
    expect(f.message).toBe('instruct_funding_mode');
    expect(new InstructFundingModeError(60).delaySec).toBe(60);

    expect(INSTRUCT_TRAVEL_RULE_DEFER_SEC).toBe(900);
    const t = new InstructTravelRuleError();
    expect(t.delaySec).toBe(900);
    expect(t.name).toBe('InstructTravelRuleError');
    expect(t.message).toBe('instruct_travel_rule');
  });
});
