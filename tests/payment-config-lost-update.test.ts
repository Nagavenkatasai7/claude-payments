import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Db, DbOrTx } from '@/db/client';

// UI redesign M3-15a follow-up: the legacy platform savePaymentConfigAction rewrites the WHOLE
// integrations row (integrations-repo.ts saveIntegrations). It used to read that row BEFORE any
// transaction and write the copy back, so a concurrent writer's change to a field this form does not
// own (the WhatsApp config, or a signing-secret rotation while the admin only changed the webhook
// secret) was silently undone. The fix: lock the tenant's partners row (SELECT … FOR UPDATE), re-read
// inside the transaction, merge only this form's fields, write + audit in the same transaction.
//
// PGlite has one connection, so a real second writer cannot block on the lock here. The race is
// modelled at the action's FIRST integrations read:
//   • read OUTSIDE a transaction (the old code): the concurrent writer commits right after it;
//   • read INSIDE a transaction: the test asserts the partners row lock is already held (pg_locks
//     RowShareLock, what FOR UPDATE takes), and the concurrent writer — which in Postgres would wait
//     on that lock — runs after the action commits, re-reading the row as a locked writer does.
// The guarantee is only as strong as the other writers: the partner-side writers that take the same
// lock land with PR #428.

let currentStaff: { username: string; role: 'admin' | 'agent' | 'support'; partnerId?: string };
vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => currentStaff,
  requireStaff: async () => currentStaff,
  requirePlatformAdmin: async () => currentStaff,
}));

let db: Db;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(db) };
});

type Writer = () => Promise<void>;
const race = vi.hoisted(() => ({
  writer: null as null | (() => Promise<void>),
  deferred: [] as Array<() => Promise<void>>,
  lockHeldAtRead: null as null | boolean,
  readOutsideTx: false,
}));

vi.mock('@/lib/partner-integrations-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-integrations-store')>('@/lib/partner-integrations-store');
  const wrap = (handle: DbOrTx) => {
    const store = actual.createPartnerIntegrationsStore(handle);
    return {
      ...store,
      async getIntegrations(id: string) {
        const value = await store.getIntegrations(id);
        const w = race.writer;
        if (w && id === 'acme') {
          race.writer = null;
          if (handle === db) {
            race.readOutsideTx = true;
            await w(); // committed between this read and the action's write
          } else {
            const r = await handle.execute(
              sql`SELECT mode FROM pg_locks WHERE locktype = 'relation' AND relation = 'partners'::regclass AND pid = pg_backend_pid() AND mode = 'RowShareLock'`,
            );
            race.lockHeldAtRead = (r as unknown as { rows: unknown[] }).rows.length > 0;
            race.deferred.push(w); // a locked writer waits for this transaction to commit
          }
        }
        return value;
      },
    };
  };
  return {
    ...actual,
    createPartnerIntegrationsStore: (handle: DbOrTx) => wrap(handle),
    getPartnerIntegrationsStore: () => wrap(db),
  };
});
const sharedRedis = fakeRedis();
vi.mock('@/lib/redis', () => ({ getRedis: () => sharedRedis }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => new Headers({ host: 'smartremit.ai' }),
}));

import { savePaymentConfigAction } from '@/app/admin-dashboard/partners/actions';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { withRotatedSecret } from '@/lib/partner-integrations';

const repo = () => createIntegrationsRepo(db);
const form = (values: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};
const OLD_URL = 'https://rail.acme-test.com/settle';
const NEW_URL = 'https://rail2.acme-test.com/settle';

async function runAction(fd: FormData, writer: Writer): Promise<void> {
  race.writer = writer;
  await savePaymentConfigAction(fd);
  for (const w of race.deferred.splice(0)) await w();
}

type AuditRow = { partner_id: string | null; actor: string; actor_type: string; action: string; subject_id: string | null; meta: Record<string, unknown> | null };
async function auditRows(): Promise<AuditRow[]> {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events ORDER BY id`);
  return (r as unknown as { rows: AuditRow[] }).rows;
}

beforeEach(async () => {
  sharedRedis.dump.clear();
  db = await freshDb();
  race.writer = null;
  race.deferred = [];
  race.lockHeldAtRead = null;
  race.readOutsideTx = false;
  currentStaff = { username: 'admin', role: 'admin' };
  await seedPartner(db, 'acme');
  await repo().saveIntegrations('acme', {
    kyc: {},
    whatsapp: {},
    payment: { providerType: 'http', credentials: { settlementUrl: OLD_URL, signingSecret: 'sg_1' }, webhookSecret: 'wh_1' },
  });
});
afterEach(() => vi.clearAllMocks());

describe('savePaymentConfigAction: a concurrent change to a field this form does not own survives', () => {
  it('a WhatsApp config written concurrently is kept, and the URL change lands', async () => {
    await runAction(form({ id: 'acme', providerType: 'http', settlementUrl: NEW_URL }), async () => {
      const cur = await repo().getIntegrations('acme');
      await repo().saveIntegrations('acme', { ...cur, whatsapp: { phoneNumberId: '5550001', token: 'tok-p', appSecret: 'app-p' } });
    });
    const after = await repo().getIntegrations('acme');
    expect(after.whatsapp).toEqual({ phoneNumberId: '5550001', token: 'tok-p', appSecret: 'app-p' });
    expect(race.readOutsideTx).toBe(false);
    expect(race.lockHeldAtRead).toBe(true);
    expect(after.payment.credentials?.settlementUrl).toBe(NEW_URL);
    expect(after.payment.credentials?.signingSecret).toBe('sg_1');
    expect(after.payment.webhookSecret).toBe('wh_1');
  });

  it('a signing-secret rotation committed concurrently is kept when the admin changes only the webhook secret', async () => {
    await runAction(form({ id: 'acme', providerType: 'http', settlementUrl: '', webhookSecret: 'wh_2' }), async () => {
      const cur = await repo().getIntegrations('acme');
      const creds = withRotatedSecret(cur.payment.credentials ?? {}, 'signing', cur.payment.credentials?.signingSecret, 'sg_partner', new Date());
      creds.signingSecret = 'sg_partner';
      await repo().saveIntegrations('acme', { ...cur, payment: { ...cur.payment, credentials: creds } });
    });
    const p = (await repo().getIntegrations('acme')).payment;
    expect(p.credentials?.signingSecret).toBe('sg_partner');
    expect(race.readOutsideTx).toBe(false);
    expect(race.lockHeldAtRead).toBe(true);
    expect(p.credentials?.previousSigningSecret).toBe('sg_1');
    expect(p.webhookSecret).toBe('wh_2');
    expect(p.credentials?.previousWebhookSecret).toBe('wh_1');
    expect(p.credentials?.settlementUrl).toBe(OLD_URL);
  });
});

describe('savePaymentConfigAction: write and audit commit together', () => {
  it('one partner.payment_config row: provider + change booleans, never a URL or secret', async () => {
    await savePaymentConfigAction(form({ id: 'acme', providerType: 'http', settlementUrl: NEW_URL, signingSecret: 'sg_2' }));
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partner_id: 'acme', actor: 'admin', actor_type: 'staff', action: 'partner.payment_config', subject_id: 'acme' });
    expect(rows[0].meta).toEqual({
      providerType: 'http',
      providerChanged: false,
      settlementUrlChanged: true,
      signingSecretChanged: true,
      webhookSecretChanged: false,
      actorScope: 'platform',
    });
    const text = JSON.stringify(rows[0]);
    for (const s of ['sg_1', 'sg_2', 'wh_1', 'rail2.acme-test.com', 'rail.acme-test.com']) expect(text).not.toContain(s);
  });

  it('a refused settlement URL writes nothing: no config change, no audit row', async () => {
    await expect(
      savePaymentConfigAction(form({ id: 'acme', providerType: 'http', settlementUrl: 'http://169.254.169.254/' })),
    ).rejects.toThrow('Settlement endpoint must be a public https:// URL.');
    expect((await repo().getIntegrations('acme')).payment.credentials?.settlementUrl).toBe(OLD_URL);
    expect(await auditRows()).toHaveLength(0);
  });
});
