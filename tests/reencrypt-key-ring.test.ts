import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';
import { EnvKeyRing, defaultProvider } from '@/lib/field-crypto';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { REENCRYPT_TABLES } from '../scripts/reencrypt-aad-v2';
import {
  KEY_RING_TABLES,
  parseKeyRingArgs,
  reencryptKeyRing,
} from '../scripts/reencrypt-key-ring';
import type { Transfer } from '@/lib/types';

// Program-Fix 45 P4 step 13: the owner-run key-ring re-encrypt. It re-seals v2
// blobs whose kid is not the configured current kid under the current kid.
// Built and tested here on PGlite; NEVER wired into package.json or CI, never
// run on production (the key is never rotated, so production has nothing to do).

// tests/setup.ts pins FIELD_ENCRYPTION_KEY to 32×0x07 (k0). k1 is another key.
const KEY_0 = Buffer.alloc(32, 7);
const KEY_1 = Buffer.alloc(32, 9);
const now = '2026-06-09T12:00:00.000Z';
let db: Db;

async function raw(query: string): Promise<Record<string, string | null>[]> {
  const res = await db.execute(sql.raw(query));
  return (res as unknown as { rows: Record<string, string | null>[] }).rows;
}

const transfer = (over: Partial<Transfer> = {}): Transfer => ({
  id: 'tr_kr1', phone: '15551230000', amountUsd: 200, feeUsd: 1.99, totalChargeUsd: 201.99, fxRate: 85.2,
  amountInr: 17040, recipientName: 'Anita', recipientPhone: '919876543210', payoutMethod: 'bank',
  payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer', complianceStatus: 'cleared',
  complianceReasons: [], status: 'awaiting_payment', createdAt: now, sourceCountry: 'US', sourceCurrency: 'USD',
  destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default', amountSource: 200, feeSource: 1.99,
  totalChargeSource: 201.99, ...over,
});

/** Rows written with the PRODUCTION config: every blob is v2.k0. */
async function seedK0(): Promise<string> {
  await seedPartner(db, 'acme');
  const ring = new EnvKeyRing(KEY_0);
  await createTransferRepo(db, ring).saveTransfer(transfer({ recipientLegalName: 'Anita Sharma' }));
  await createIntegrationsRepo(db, ring).saveIntegrations('acme', {
    kyc: { providerType: 'persona', apiKey: 'persona_x', webhookSecret: 'whk_x' },
    payment: {},
    whatsapp: {},
  });
  const t = await createTicketRepo(db, { cryptoProvider: ring }).createTicket({
    id: 'tk_kr1', partnerId: 'acme', kind: 'customer', customerPhone: '15551230000', subject: 's', body: 'where is it',
  });
  return t.id;
}

function rotateEnv() {
  vi.stubEnv('FIELD_ENCRYPTION_PREVIOUS_KEYS', `k1:${KEY_1.toString('hex')}`);
  vi.stubEnv('FIELD_ENCRYPTION_CURRENT_KID', 'k1');
}

beforeEach(async () => {
  db = await freshDb();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('scripts/reencrypt-key-ring (fix 45 P4)', { retry: 0 }, () => {
  it('covers every fix-46 column plus ticket_messages.body', () => {
    const cols = KEY_RING_TABLES.flatMap((t) => t.columns.map((c) => `${t.table}.${c}`)).sort();
    const expected = [
      ...REENCRYPT_TABLES.flatMap((t) => t.columns.map((c) => `${t.table}.${c}`)),
      'ticket_messages.body',
    ].sort();
    expect(cols).toEqual(expected);
  });

  it('with the production config (current kid k0) finds nothing to do', async () => {
    await seedK0();
    const report = await reencryptKeyRing(db, { apply: true });
    expect(report.reduce((n, r) => n + r.stale, 0)).toBe(0);
    expect(report.every((r) => r.resealed === 0 && r.skipped === 0 && r.failed === 0)).toBe(true);
  });

  it('DRY RUN (default) counts k0 rows once the current kid is k1 and writes nothing', async () => {
    await seedK0();
    rotateEnv();
    const before = await raw(`SELECT payout_destination_enc FROM transfers`);
    const report = await reencryptKeyRing(db, { apply: false });
    const r = (t: string, c: string) => report.find((x) => x.table === t && x.column === c)!;
    expect(r('transfers', 'payout_destination_enc')).toMatchObject({ stale: 1, resealed: 0 });
    expect(r('transfers', 'recipient_legal_name_enc')).toMatchObject({ stale: 1, resealed: 0 });
    expect(r('ticket_messages', 'body')).toMatchObject({ stale: 1, resealed: 0 });
    expect(await raw(`SELECT payout_destination_enc FROM transfers`)).toEqual(before);
  });

  it('--apply re-seals every stale blob under k1, and the repos still read them', async () => {
    const ticketId = await seedK0();
    rotateEnv();
    const report = await reencryptKeyRing(db, { apply: true });
    expect(report.reduce((n, r) => n + r.failed + r.skipped, 0)).toBe(0);
    expect(report.reduce((n, r) => n + r.resealed, 0)).toBe(report.reduce((n, r) => n + r.stale, 0));
    const [tr] = await raw(`SELECT payout_destination_enc, recipient_legal_name_enc FROM transfers`);
    expect(tr.payout_destination_enc?.startsWith('v2.k1.')).toBe(true);
    expect(tr.recipient_legal_name_enc?.startsWith('v2.k1.')).toBe(true);
    const [tm] = await raw(`SELECT body FROM ticket_messages`);
    expect(tm.body?.startsWith('v2.k1.')).toBe(true);

    // Reads through the env ring (k0 + k1) return the same plaintext.
    const got = await createTransferRepo(db, defaultProvider()).getTransfer('tr_kr1', { decrypt: true });
    expect(got?.payoutDestination).toBe('123456789012|HDFC0001234');
    expect(got?.recipientLegalName).toBe('Anita Sharma');
    const msgs = await createTicketRepo(db).listMessages(ticketId, { includeInternal: true });
    expect(msgs[0].body).toBe('where is it');
    const integ = await createIntegrationsRepo(db, defaultProvider()).getIntegrations('acme');
    expect(integ.kyc.apiKey).toBe('persona_x');

    // A second run has nothing left.
    const again = await reencryptKeyRing(db, { apply: true });
    expect(again.reduce((n, r) => n + r.stale, 0)).toBe(0);
  });

  it('leaves legacy plaintext ticket bodies and v1 blobs alone (not this script\'s job)', async () => {
    const ticketId = await seedK0();
    await db.execute(sql`INSERT INTO ticket_messages (ticket_id, actor_type, actor_id, body) VALUES (${ticketId}, 'customer', '1', 'legacy plain')`);
    rotateEnv();
    await reencryptKeyRing(db, { apply: true });
    const bodies = (await raw(`SELECT body FROM ticket_messages ORDER BY id`)).map((r) => r.body);
    expect(bodies).toContain('legacy plain');
  });

  it('the compare-and-set skips a row changed concurrently', async () => {
    await seedK0();
    rotateEnv();
    let bumped = false;
    const report = await reencryptKeyRing(db, {
      apply: true,
      table: 'ticket_messages',
      beforeWrite: async () => {
        if (bumped) return;
        bumped = true;
        await db.execute(sql`UPDATE ticket_messages SET body = 'changed concurrently'`);
      },
    });
    expect(report[0]).toMatchObject({ table: 'ticket_messages', stale: 1, resealed: 0, skipped: 1 });
    expect((await raw(`SELECT body FROM ticket_messages`))[0].body).toBe('changed concurrently');
  });

  it('refuses to run when the current kid is not in the ring (fail closed, nothing written)', async () => {
    await seedK0();
    vi.stubEnv('FIELD_ENCRYPTION_CURRENT_KID', 'k2');
    const before = await raw(`SELECT body FROM ticket_messages`);
    await expect(reencryptKeyRing(db, { apply: true })).rejects.toThrow(/FIELD_ENCRYPTION_CURRENT_KID/);
    expect(await raw(`SELECT body FROM ticket_messages`)).toEqual(before);
  });

  it('parses args: dry run by default; --apply needs --confirm-snapshot-taken; --table and --batch validated', () => {
    expect(parseKeyRingArgs([])).toEqual({ ok: true, apply: false, batch: 200, table: undefined });
    expect(parseKeyRingArgs(['--apply']).ok).toBe(false);
    expect(parseKeyRingArgs(['--apply', '--confirm-snapshot-taken', '--table', 'ticket_messages'])).toEqual({
      ok: true, apply: true, batch: 200, table: 'ticket_messages',
    });
    expect(parseKeyRingArgs(['--table', 'nope']).ok).toBe(false);
    expect(parseKeyRingArgs(['--batch', '0']).ok).toBe(false);
  });

  it('is never wired into package.json or CI', () => {
    expect(readFileSync('package.json', 'utf8')).not.toContain('reencrypt-key-ring');
    for (const wf of ['ci.yml', 'smoke.yml']) {
      let text = '';
      try {
        text = readFileSync(`.github/workflows/${wf}`, 'utf8');
      } catch {
        text = '';
      }
      expect(text).not.toContain('reencrypt-key-ring');
    }
  });
});
