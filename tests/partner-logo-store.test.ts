import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { partners, auditEvents } from '@/db/schema';
import type { Db } from '@/db/client';
import { validateNewLogo, renderableLogoSrc, savePartnerLogo } from '@/lib/partner-logo-store';

const uri = (type: string, bytes: Buffer) => `data:image/${type};base64,${bytes.toString('base64')}`;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG = uri('png', PNG_BYTES);
const JPG = uri('jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]));
const WEBP = uri('webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]));
const SVG = uri('svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
const GIF = uri('gif', Buffer.from('GIF89a'));
const LIAR = uri('png', Buffer.from('<svg onload=alert(1)>'));

describe('validateNewLogo (owner: PNG/JPEG/WebP only, 512 KB)', () => {
  it.each([PNG, JPG, WEBP])('accepts %#', (v) => expect(validateNewLogo(v)).toEqual({ ok: true, value: v }));
  it('rejects svg, gif, https URLs and junk', () => {
    expect(validateNewLogo(SVG)).toEqual({ ok: false, reason: 'type' });
    expect(validateNewLogo(GIF)).toEqual({ ok: false, reason: 'type' });
    expect(validateNewLogo('https://cdn.example/logo.png')).toEqual({ ok: false, reason: 'type' });
    expect(validateNewLogo(42)).toEqual({ ok: false, reason: 'type' });
    expect(validateNewLogo(null)).toEqual({ ok: false, reason: 'type' });
    expect(validateNewLogo('')).toEqual({ ok: false, reason: 'type' });
    expect(validateNewLogo('javascript:alert(1)')).toEqual({ ok: false, reason: 'type' });
  });
  it('rejects non-canonical headers (jpg alias, uppercase, extra params, leading space, no base64 marker)', () => {
    const b64 = PNG.slice(PNG.indexOf(',') + 1);
    expect(validateNewLogo(`data:image/jpg;base64,${JPG.slice(JPG.indexOf(',') + 1)}`)).toEqual({ ok: false, reason: 'type' });
    expect(validateNewLogo(`DATA:IMAGE/PNG;BASE64,${b64}`)).toEqual({ ok: false, reason: 'type' });
    expect(validateNewLogo(`data:image/png;charset=utf-8;base64,${b64}`)).toEqual({ ok: false, reason: 'type' });
    expect(validateNewLogo(` ${PNG}`)).toEqual({ ok: false, reason: 'type' });
    expect(validateNewLogo(`data:image/png,${b64}`)).toEqual({ ok: false, reason: 'type' });
  });
  it('rejects a type/content mismatch (declared png, bytes are svg)', () => {
    expect(validateNewLogo(LIAR)).toEqual({ ok: false, reason: 'content' });
    expect(validateNewLogo(uri('jpeg', PNG_BYTES))).toEqual({ ok: false, reason: 'content' });
    expect(validateNewLogo(uri('webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')])))).toEqual({ ok: false, reason: 'content' });
    expect(validateNewLogo(uri('png', Buffer.from('GIF89a')))).toEqual({ ok: false, reason: 'content' });
    expect(validateNewLogo(uri('png', Buffer.from([0x89, 0x50])))).toEqual({ ok: false, reason: 'content' }); // truncated
  });
  it('rejects a payload that is not strict base64 (whitespace, junk, bad padding, empty)', () => {
    const b64 = PNG.slice(PNG.indexOf(',') + 1);
    expect(validateNewLogo(`data:image/png;base64,${b64.slice(0, 4)} ${b64.slice(4)}`)).toEqual({ ok: false, reason: 'content' });
    expect(validateNewLogo(`data:image/png;base64,${b64}\n`)).toEqual({ ok: false, reason: 'content' });
    expect(validateNewLogo(`data:image/png;base64,${b64}"><script>`)).toEqual({ ok: false, reason: 'content' });
    expect(validateNewLogo(`data:image/png;base64,${b64}===`)).toEqual({ ok: false, reason: 'content' });
    expect(validateNewLogo('data:image/png;base64,')).toEqual({ ok: false, reason: 'content' });
  });
  it('rejects oversize', () => {
    expect(validateNewLogo('data:image/png;base64,' + 'A'.repeat(512 * 1024))).toEqual({ ok: false, reason: 'size' });
  });
});

describe('renderableLogoSrc (legacy-tolerant, <img> only)', () => {
  it('keeps legacy https and svg values renderable, drops junk', () => {
    expect(renderableLogoSrc('https://cdn.example/l.png')).toBe('https://cdn.example/l.png');
    expect(renderableLogoSrc(SVG)).toBe(SVG);
    expect(renderableLogoSrc(GIF)).toBe(GIF);
    expect(renderableLogoSrc(PNG)).toBe(PNG);
    expect(renderableLogoSrc('javascript:alert(1)')).toBeNull();
    expect(renderableLogoSrc('http://insecure.example/l.png')).toBeNull();
    expect(renderableLogoSrc('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(renderableLogoSrc('')).toBeNull();
    expect(renderableLogoSrc(null)).toBeNull();
    expect(renderableLogoSrc({})).toBeNull();
  });
});

describe('savePartnerLogo', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await db.insert(partners).values([{ id: 'pa', name: 'A' }, { id: 'pb', name: 'B', logoUrl: 'https://b.example/l.png' }]);
  });
  const logoOf = async (id: string) =>
    (await db.select({ logoUrl: partners.logoUrl }).from(partners).where(eq(partners.id, id)))[0]?.logoUrl;
  const logoAudits = () =>
    db.select({ partnerId: auditEvents.partnerId, actor: auditEvents.actor, actorType: auditEvents.actorType, subjectId: auditEvents.subjectId, meta: auditEvents.meta })
      .from(auditEvents).where(eq(auditEvents.action, 'partner.logo.update'));

  it('writes ONLY that partner’s logo_url and audits in the same transaction', async () => {
    expect(await savePartnerLogo(db, 'pa', PNG, 'admin-a')).toEqual({ ok: true });
    expect(await logoOf('pa')).toBe(PNG);
    expect(await logoOf('pb')).toBe('https://b.example/l.png'); // tenant isolation
    const audit = await logoAudits();
    expect(audit).toEqual([{ partnerId: 'pa', actor: 'admin-a', actorType: 'staff', subjectId: 'pa', meta: { bytes: PNG_BYTES.length } }]);
    expect(JSON.stringify(audit[0]!.meta)).not.toContain('base64'); // never the image itself
  });
  it('partner B writing its own logo never touches A', async () => {
    await savePartnerLogo(db, 'pa', PNG, 'admin-a');
    expect(await savePartnerLogo(db, 'pb', JPG, 'admin-b')).toEqual({ ok: true });
    expect(await logoOf('pa')).toBe(PNG);
    expect(await logoOf('pb')).toBe(JPG);
    expect((await logoAudits()).map((a) => [a.partnerId, a.subjectId])).toEqual([['pa', 'pa'], ['pb', 'pb']]);
  });
  it('refuses an invalid logo with no write and no audit', async () => {
    expect(await savePartnerLogo(db, 'pa', SVG, 'x')).toEqual({ ok: false, reason: 'type' });
    expect(await savePartnerLogo(db, 'pa', LIAR, 'x')).toEqual({ ok: false, reason: 'content' });
    expect(await logoOf('pa')).toBeNull();
    expect(await db.select({ id: auditEvents.id }).from(auditEvents)).toHaveLength(0);
  });
  it('an unknown partner is not_found with no audit', async () => {
    expect(await savePartnerLogo(db, 'nope', PNG, 'x')).toEqual({ ok: false, reason: 'not_found' });
    expect(await db.select({ id: auditEvents.id }).from(auditEvents)).toHaveLength(0);
  });
  it('if the audit insert fails, the logo write rolls back (one transaction)', async () => {
    await expect(savePartnerLogo(db, 'pa', PNG, null as unknown as string)).rejects.toThrow();
    expect(await logoOf('pa')).toBeNull();
  });
  it('runs on a caller transaction without nesting', async () => {
    await db.transaction(async (tx) => {
      expect(await savePartnerLogo(tx, 'pa', WEBP, 'admin-a')).toEqual({ ok: true });
    });
    expect(await logoOf('pa')).toBe(WEBP);
  });
});
