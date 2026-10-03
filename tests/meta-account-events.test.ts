import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { parseMetaAccountEvents, metaAccountEventAlert } from '@/lib/meta-account-events';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';

// 2026-10-03 (Batch 1 A5): Meta's template-status, template-category and
// number-quality webhooks become deduped ops alerts instead of being ignored.

const body = (field: string, value: unknown, time = 1_759_500_000) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA1', time, changes: [{ field, value }] }],
});

describe('parseMetaAccountEvents (pure)', () => {
  it('reads a template status update', () => {
    expect(parseMetaAccountEvents(body('message_template_status_update', {
      event: 'REJECTED', message_template_id: 123, message_template_name: 'scheduled_payment_ready',
      message_template_language: 'en', reason: 'INCORRECT_CATEGORY',
    }))).toEqual([{
      field: 'message_template_status_update', time: 1_759_500_000, templateName: 'scheduled_payment_ready',
      templateLanguage: 'en', event: 'REJECTED', reason: 'INCORRECT_CATEGORY',
    }]);
  });

  it('reads a template category update (both shapes)', () => {
    const [done] = parseMetaAccountEvents(body('template_category_update', {
      message_template_id: 1, message_template_name: 'transfer_delivered', message_template_language: 'en_US',
      previous_category: 'UTILITY', new_category: 'MARKETING',
    }));
    expect(done).toMatchObject({ previousCategory: 'UTILITY', newCategory: 'MARKETING', templateLanguage: 'en_US' });
    const [soon] = parseMetaAccountEvents(body('template_category_update', {
      message_template_name: 'transfer_delivered', message_template_language: 'en', new_category: 'UTILITY', correct_category: 'MARKETING',
    }));
    expect(soon).toMatchObject({ newCategory: 'UTILITY', correctCategory: 'MARKETING' });
  });

  it('reads a number quality update with only the last 4 digits of the number', () => {
    const [ev] = parseMetaAccountEvents(body('phone_number_quality_update', {
      display_phone_number: '15556308178', event: 'DOWNGRADE', current_limit: 'TIER_250',
    }));
    expect(ev).toEqual({ field: 'phone_number_quality_update', time: 1_759_500_000, event: 'DOWNGRADE', phoneLast4: '8178', currentLimit: 'TIER_250' });
    expect(JSON.stringify(ev)).not.toContain('1555630');
  });

  it('ignores message changes, unknown fields and garbage; drops odd values instead of guessing', () => {
    expect(parseMetaAccountEvents({ entry: [{ changes: [{ field: 'messages', value: { messages: [] } }] }] })).toEqual([]);
    expect(parseMetaAccountEvents(body('account_update', { event: 'X' }))).toEqual([]);
    expect(parseMetaAccountEvents(null)).toEqual([]);
    expect(parseMetaAccountEvents({ entry: 'x' })).toEqual([]);
    const [ev] = parseMetaAccountEvents(body('message_template_status_update', {
      event: 'APPROVED', message_template_name: 'Bad Name <script>', message_template_language: 'english!!',
    }));
    expect(ev).toEqual({ field: 'message_template_status_update', time: 1_759_500_000, event: 'APPROVED' });
  });
});

describe('metaAccountEventAlert (pure)', () => {
  const tpl = (event: string, extra: Record<string, unknown> = {}) =>
    parseMetaAccountEvents(body('message_template_status_update', { event, message_template_name: 'ops_alert', message_template_language: 'en', ...extra }))[0];

  it('approved: says it can be used', () => {
    expect(metaAccountEventAlert(tpl('APPROVED'), 'default').message).toBe('Meta approved the WhatsApp template "ops_alert" (en). It can be used now.');
  });

  it('rejected / paused: says action is needed, with the reason', () => {
    const m = metaAccountEventAlert(tpl('REJECTED', { reason: 'INCORRECT_CATEGORY' }), 'default').message;
    expect(m).toMatch(/^Action needed: Meta marked the WhatsApp template "ops_alert" \(en\) as REJECTED \(reason: INCORRECT_CATEGORY\)\./);
    expect(metaAccountEventAlert(tpl('PAUSED', { reason: 'NONE' }), 'default').message).not.toContain('reason');
  });

  it("names the partner for a partner's own account", () => {
    expect(metaAccountEventAlert(tpl('APPROVED'), 'acme').message).toContain('(partner acme)');
  });

  it('category and quality messages', () => {
    const [cat] = parseMetaAccountEvents(body('template_category_update', { message_template_name: 'x_y', message_template_language: 'en', previous_category: 'UTILITY', new_category: 'MARKETING' }));
    expect(metaAccountEventAlert(cat, 'default').message).toContain('from UTILITY to MARKETING');
    const [q] = parseMetaAccountEvents(body('phone_number_quality_update', { display_phone_number: '15556308178', event: 'FLAGGED' }));
    expect(metaAccountEventAlert(q, 'default').message).toBe("WhatsApp number ending 8178 quality update: FLAGGED. Check the number's status in WhatsApp Manager.");
  });

  it('dedupe key: same event + same send time ⇒ same key; a later event ⇒ a new key', () => {
    const a = metaAccountEventAlert(tpl('APPROVED'), 'default').dedupeKey;
    expect(metaAccountEventAlert(tpl('APPROVED'), 'default').dedupeKey).toBe(a);
    const later = parseMetaAccountEvents(body('message_template_status_update', { event: 'APPROVED', message_template_name: 'ops_alert', message_template_language: 'en' }, 1_759_600_000))[0];
    expect(metaAccountEventAlert(later, 'default').dedupeKey).not.toBe(a);
    expect(metaAccountEventAlert(tpl('REJECTED'), 'default').dedupeKey).not.toBe(a);
    expect(metaAccountEventAlert(tpl('APPROVED'), 'acme').dedupeKey).not.toBe(a);
  });
});

// The inbound pipeline: an account event becomes exactly one ops.alert row.
let db: Db;
const redis = fakeRedis();
vi.mock('@/db/client', () => ({ getDb: () => db }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/outbox', () => ({ pokeWorker: vi.fn(), pokeWorkerDelayed: vi.fn() }));

describe('processInboundWebhook — Meta account events', () => {
  beforeEach(async () => {
    redis.dump.clear();
    db = await freshDb();
  });
  afterEach(() => vi.restoreAllMocks());

  async function alertRows() {
    const r = await db.execute(sql`SELECT kind, payload, dedupe_key FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
    return (r as unknown as { rows: Array<{ kind: string; payload: { message: string }; dedupe_key: string }> }).rows;
  }

  it('enqueues one ops alert; a redelivery of the same POST adds none', async () => {
    const { processInboundWebhook } = await import('@/lib/whatsapp-inbound');
    const b = body('message_template_status_update', { event: 'REJECTED', message_template_name: 'ops_alert', message_template_language: 'en', reason: 'PROMOTIONAL' });
    await processInboundWebhook(b, { routedPartnerId: null, acceptPnid: async (p) => p === null });
    await processInboundWebhook(b, { routedPartnerId: null, acceptPnid: async (p) => p === null });
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.message).toContain('"ops_alert" (en) as REJECTED (reason: PROMOTIONAL)');
    expect(rows[0].dedupe_key).toMatch(/^metaacct:default:message_template_status_update:ops_alert:en:REJECTED:/);
  });

  it("a partner-signed POST alerts under the partner (even when its route only accepts its own number's changes)", async () => {
    const { processInboundWebhook } = await import('@/lib/whatsapp-inbound');
    const b = body('phone_number_quality_update', { display_phone_number: '15550001234', event: 'DOWNGRADE', current_limit: 'TIER_250' });
    await processInboundWebhook(b, { routedPartnerId: 'acme', acceptPnid: async (p) => p === 'PNID_ACME' });
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.message).toContain('(partner acme)');
    expect(rows[0].payload.message).not.toContain('15550001234');
  });
});
