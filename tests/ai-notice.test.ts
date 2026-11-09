import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  AI_NOTICE_INTERVAL_MS,
  AI_NOTICE_VERSION,
  aiNoticeDue,
  aiNoticeText,
  detectReplyLang,
  withAiNotice,
  type AiNoticeChannel,
  type NoticeLang,
} from '@/lib/ai-notice';
import { AI_NOTICE_ACTION, aiNoticeDueFor, lastAiNoticeAt, recordAiNotice } from '@/lib/ai-notice-marker';
import { auditSubjectId } from '@/lib/customer-ref';
import { freshDb, seedPartner } from './helpers-db';
import type { Db } from '@/db/client';

// R17: customers are told they are talking to an AI. The notice leads the first
// reply of a conversation and comes back after 24 hours, on WhatsApp, Telegram,
// voice notes and the web chat. It is policy, not a setting: nothing here can
// switch it off.

const LANGS: NoticeLang[] = ['en', 'hinglish', 'es'];
const CHANNELS: AiNoticeChannel[] = ['whatsapp', 'telegram', 'voice', 'web'];

describe('aiNoticeText', () => {
  it.each(LANGS.flatMap((l) => CHANNELS.map((c) => [l, c] as const)))('%s / %s says AI, offers HELP, and never says "partner"', (lang, channel) => {
    const t = aiNoticeText(lang, channel);
    expect(t).toMatch(/\b(AI|IA)\b/);
    expect(t).toContain('HELP');
    expect(t.toLowerCase()).not.toContain('partner');
    expect(t).not.toMatch(/\d/);
    expect(t.split('\n')).toHaveLength(1);
  });

  it('a voice note is told its voice is turned into text by a machine', () => {
    expect(aiNoticeText('en', 'voice')).not.toBe(aiNoticeText('en', 'whatsapp'));
    expect(aiNoticeText('en', 'voice').toLowerCase()).toContain('voice');
  });

  it('the provider line is added on its own line only when given (PR4 fills it)', () => {
    const line = 'Payments by Example Bank, licensed by a regulator';
    expect(aiNoticeText('en', 'whatsapp', line)).toBe(`${aiNoticeText('en', 'whatsapp')}\n${line}`);
    expect(aiNoticeText('en', 'whatsapp', '')).toBe(aiNoticeText('en', 'whatsapp'));
    expect(aiNoticeText('en', 'whatsapp', ' \n ')).toBe(aiNoticeText('en', 'whatsapp'));
  });

  it('has a version for the owner and counsel sign-off', () => {
    expect(AI_NOTICE_VERSION).toMatch(/\S/);
  });
});

describe('withAiNotice', () => {
  const n = aiNoticeText('en', 'whatsapp');
  it('puts the notice first, then a blank line, then the reply', () => {
    expect(withAiNotice('Hi! How can I help?', n)).toBe(`${n}\n\nHi! How can I help?`);
  });
  it('is idempotent: applied twice equals once', () => {
    const once = withAiNotice('Hello', n);
    expect(withAiNotice(once, n)).toBe(once);
  });
  it('an empty notice changes nothing; an empty reply is the notice alone', () => {
    expect(withAiNotice('Hello', '')).toBe('Hello');
    expect(withAiNotice('', n)).toBe(n);
    expect(withAiNotice('   ', n)).toBe(n);
  });
});

describe('aiNoticeDue', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  it('never shown ⇒ due', () => expect(aiNoticeDue(null, now)).toBe(true));
  it('shown under 24 hours ago ⇒ not due', () => {
    expect(aiNoticeDue(new Date(now.getTime() - AI_NOTICE_INTERVAL_MS + 60_000), now)).toBe(false);
  });
  it('shown 24 hours ago or more ⇒ due again', () => {
    expect(aiNoticeDue(new Date(now.getTime() - AI_NOTICE_INTERVAL_MS), now)).toBe(true);
    expect(aiNoticeDue(new Date(now.getTime() - 3 * AI_NOTICE_INTERVAL_MS), now)).toBe(true);
  });
  it('the interval is 24 hours', () => expect(AI_NOTICE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000));
});

describe('detectReplyLang', () => {
  it.each([
    ['send $200 to mom', 'en'],
    ['hi', 'en'],
    ['मुझे पैसे भेजने हैं', 'hinglish'],
    ['mujhe paise bhejne hai', 'hinglish'],
    ['kya haal hai, mujhe mummy ko paise bhejna hai', 'hinglish'],
    ['hola, quiero enviar dinero a mi mamá', 'es'],
    ['¿cuánto cuesta?', 'es'],
    // R56: the off-topic decline must be in the language of the request too.
    ['escríbeme un poema', 'es'],
    ['mujhe ek kavita likh do', 'hinglish'],
    ['tell me a joke', 'en'],
    ['Priya', 'en'],
    ['', 'en'],
  ] as const)('%j → %s', (text, lang) => {
    expect(detectReplyLang(text)).toBe(lang);
  });
  it('never throws on a non-string', () => {
    expect(detectReplyLang(undefined)).toBe('en');
    expect(detectReplyLang(7)).toBe('en');
  });
});

describe('the durable last-notice marker (audit_events ai.notice_shown)', () => {
  let db: Db;
  const PHONE = '15551230000';
  beforeEach(async () => {
    db = await freshDb();
  });

  it('records one audit row: tenant, keyed subject, channel, language and version, never the phone', async () => {
    await recordAiNotice(db, { partnerId: 'default', phone: PHONE, surface: 'wa', channel: 'voice', lang: 'en' });
    const r = await db.execute(sql`SELECT partner_id, actor_type, action, subject_id, meta FROM audit_events WHERE action = ${AI_NOTICE_ACTION}`);
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0] as { partner_id: string; actor_type: string; subject_id: string; meta: Record<string, unknown> };
    expect(row.partner_id).toBe('default');
    expect(row.actor_type).toBe('system');
    expect(row.subject_id).toBe(auditSubjectId('default', PHONE));
    expect(row.meta).toEqual({ surface: 'wa', channel: 'voice', lang: 'en', version: AI_NOTICE_VERSION });
    expect(JSON.stringify(r.rows)).not.toContain(PHONE);
  });

  it('lastAiNoticeAt is per tenant, phone and surface', async () => {
    await seedPartner(db, 'acme');
    expect(await lastAiNoticeAt(db, 'default', PHONE, 'wa')).toBeNull();
    await recordAiNotice(db, { partnerId: 'default', phone: PHONE, surface: 'wa', channel: 'whatsapp', lang: 'en' });
    expect(await lastAiNoticeAt(db, 'default', PHONE, 'wa')).toBeInstanceOf(Date);
    expect(await lastAiNoticeAt(db, 'default', PHONE, 'web')).toBeNull();
    expect(await lastAiNoticeAt(db, 'default', PHONE, 'tg')).toBeNull();
    expect(await lastAiNoticeAt(db, 'acme', PHONE, 'wa')).toBeNull();
    expect(await lastAiNoticeAt(db, 'default', '15559990000', 'wa')).toBeNull();
  });

  it('aiNoticeDueFor: due before the first notice, not due right after, due again after 24 hours', async () => {
    expect(await aiNoticeDueFor(db, 'default', PHONE, 'wa')).toBe(true);
    await recordAiNotice(db, { partnerId: 'default', phone: PHONE, surface: 'wa', channel: 'whatsapp', lang: 'en' });
    expect(await aiNoticeDueFor(db, 'default', PHONE, 'wa')).toBe(false);
    expect(await aiNoticeDueFor(db, 'default', PHONE, 'wa', new Date(Date.now() + AI_NOTICE_INTERVAL_MS + 1000))).toBe(true);
  });

  it('fails safe: an unreadable marker means the notice is shown', async () => {
    const broken = { select: () => { throw new Error('db down'); } } as unknown as Db;
    expect(await aiNoticeDueFor(broken, 'default', PHONE, 'wa')).toBe(true);
  });
});
