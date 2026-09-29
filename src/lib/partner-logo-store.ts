// partner-logo-store — the ONE module that stores and serves a partner logo.
//
// Today a logo lives in partners.logo_url as a base64 image data URI. Everything that writes a
// NEW logo or turns a stored one into an <img src> goes through here, so moving logos to object
// storage later is a one-file change.
//
//  - validateNewLogo: the narrowed rule for NEW writes. PNG, JPEG or WebP base64 data URI only,
//    at most MAX_LOGO_LEN characters, strict base64, and the decoded leading bytes must be the
//    declared format's signature (a declared type alone is never trusted).
//  - renderableLogoSrc: legacy-tolerant render path. Values already stored by the existing admin
//    form (https URLs, gif/svg data URIs) still render, but ONLY as an <img src>, which never
//    executes script. A logo value must never be placed in a <style> or CSS url().
//  - savePartnerLogo: validated single-column write + a `partner.logo.update` audit row in the
//    SAME transaction, scoped to exactly one partner id.
//
// The existing admin logo form (sanitizeLogoValue on the full-row save) is deliberately left
// unchanged here; render-time handling above is what keeps its values safe.
import { eq } from 'drizzle-orm';
import { partners } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { MAX_LOGO_LEN, sanitizeLogoValue } from '@/lib/logo';
import type { PartnerId } from '@/lib/types';

export type NewLogoResult = { ok: true; value: string } | { ok: false; reason: 'type' | 'size' | 'content' };
export type SaveLogoResult = { ok: true } | { ok: false; reason: 'type' | 'size' | 'content' | 'not_found' };

type LogoType = 'png' | 'jpeg' | 'webp';
const HEADER = /^data:image\/(png|jpeg|webp);base64,/;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function hasSignature(type: LogoType, b: Buffer): boolean {
  switch (type) {
    case 'png':
      return b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    case 'jpeg':
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'webp':
      return b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
  }
}

function decodeLogo(raw: unknown): { ok: true; value: string; bytes: number } | { ok: false; reason: 'type' | 'size' | 'content' } {
  if (typeof raw !== 'string') return { ok: false, reason: 'type' };
  const m = HEADER.exec(raw);
  if (!m) return { ok: false, reason: 'type' };
  if (raw.length > MAX_LOGO_LEN) return { ok: false, reason: 'size' };
  const payload = raw.slice(m[0].length);
  if (payload.length === 0 || !STRICT_BASE64.test(payload)) return { ok: false, reason: 'content' };
  const bytes = Buffer.from(payload, 'base64');
  if (!hasSignature(m[1] as LogoType, bytes)) return { ok: false, reason: 'content' };
  return { ok: true, value: raw, bytes: bytes.length };
}

/** The narrowed rule for NEW logo writes (see the module header). Pure. */
export function validateNewLogo(raw: unknown): NewLogoResult {
  const r = decodeLogo(raw);
  return r.ok ? { ok: true, value: r.value } : r;
}

/** A stored logo value → a value that is safe ONLY as an <img src>, or null. Legacy-tolerant. */
export function renderableLogoSrc(stored: unknown): string | null {
  return sanitizeLogoValue(stored) ?? null;
}

type TxRunner = { transaction?: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> };
/** Run `fn` in a transaction when holding a Db; inside an existing tx, share it. */
function inTx<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  const maybeTx = db as TxRunner;
  return maybeTx.transaction ? maybeTx.transaction(fn) : fn(db);
}

/**
 * Validate, then write ONE partner's logo_url and its audit row in one transaction.
 * Caller: the /partner Branding action (M3-17), which derives partnerId from the authenticated
 * session, never the request body, and passes `opts.actorScope` (session-derived) for the audit meta.
 */
export async function savePartnerLogo(
  db: DbOrTx,
  partnerId: PartnerId,
  raw: unknown,
  actor: string,
  opts: { actorScope?: 'platform' | 'partner' } = {},
): Promise<SaveLogoResult> {
  const v = decodeLogo(raw);
  if (!v.ok) return v;
  return inTx(db, async (tx) => {
    const updated = await tx
      .update(partners)
      .set({ logoUrl: v.value, updatedAt: new Date() })
      .where(eq(partners.id, partnerId))
      .returning({ id: partners.id });
    if (updated.length === 0) return { ok: false, reason: 'not_found' } as const;
    await createAuditRepo(tx).record({
      partnerId,
      actor,
      actorType: 'staff',
      action: 'partner.logo.update',
      subjectId: partnerId,
      meta: { bytes: v.bytes, ...(opts.actorScope ? { actorScope: opts.actorScope } : {}) },
    });
    return { ok: true } as const;
  });
}
