import { desc, sql } from 'drizzle-orm';
import { waitlistSignups } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { blindIndex, deriveBlindIndexKey } from '@/lib/blind-index';
import { decryptField, defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { initialOf, maskEmail, type WaitlistCsvRow, type WaitlistSignupInput } from '@/lib/waitlist';
import { last4 } from './mappers';

// waitlist-repo — storage for the public "Join waitlist" signups.
//
// Encryption policy: name, email, phone and location are envelope-encrypted
// (field-crypto) at write time; the masked siblings (initial, a***@domain,
// last-4) are computed HERE so `listMasked` never touches the master key.
// Dedupe: the two UNIQUE blind-index columns (keyed HMAC of the normalised
// email / E.164 phone — src/lib/blind-index.ts) make a repeat signup a
// structural no-op. `listDecrypted` is the ONE decrypting read; its caller
// (the CSV export) is admin-only and audited.

export interface WaitlistSignupRecord extends WaitlistSignupInput {
  id: string;
  consentAt: string; // ISO-8601, server time
  consentTextVersion: string;
}

export interface WaitlistSignupMasked {
  id: string;
  nameInitial: string;
  emailMasked: string;
  phoneLast4: string;
  destinations: string[];
  consentAt: string;
  consentTextVersion: string;
  utmSource: string | undefined;
  utmCampaign: string | undefined;
  createdAt: string;
}

export interface WaitlistCounts {
  total: number;
  byCountry: Record<string, number>;
}

export function createWaitlistRepo(
  db: DbOrTx,
  provider: EncryptionKeyProvider = defaultProvider(),
  bidxKey?: Buffer,
) {
  const indexKey = () => bidxKey ?? deriveBlindIndexKey();
  const common = (row: typeof waitlistSignups.$inferSelect) => ({
    id: row.id,
    destinations: (row.destinations as string[]) ?? [],
    consentAt: row.consentAt.toISOString(),
    consentTextVersion: row.consentTextVersion,
    utmSource: row.utmSource ?? undefined,
    utmCampaign: row.utmCampaign ?? undefined,
    createdAt: row.createdAt.toISOString(),
  });

  return {
    /**
     * Insert unless the email OR phone is already on the list. Returns true when
     * a row was written, false on a duplicate — the caller treats both as
     * success (no enumeration of who is already signed up). `onConflictDoNothing()`
     * with no target covers EITHER unique index
     * (node_modules/drizzle-orm/pg-core/query-builders/insert.d.ts:138); the
     * `.returning()` length is the driver-agnostic inserted count (the same
     * contract createIdempotencyRepo.claim relies on).
     */
    async insertIfNew(s: WaitlistSignupRecord): Promise<boolean> {
      const key = indexKey();
      const inserted = await db
        .insert(waitlistSignups)
        .values({
          id: s.id,
          fullNameEnc: encryptField(s.fullName, provider),
          emailEnc: encryptField(s.email, provider),
          phoneEnc: encryptField(s.phone, provider),
          locationEnc: encryptField(s.location, provider),
          emailBidx: blindIndex('email', s.email, key),
          phoneBidx: blindIndex('phone', s.phone, key),
          nameInitial: initialOf(s.fullName),
          emailMasked: maskEmail(s.email),
          phoneLast4: last4(s.phone),
          destinations: s.destinations,
          consentAt: new Date(s.consentAt),
          consentTextVersion: s.consentTextVersion,
          utmSource: s.utmSource ?? null,
          utmCampaign: s.utmCampaign ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: waitlistSignups.id });
      return inserted.length > 0;
    },

    /** The admin list: masked siblings only — no decrypt, no ciphertext leaves the repo. */
    async listMasked(): Promise<WaitlistSignupMasked[]> {
      const rows = await db.select().from(waitlistSignups).orderBy(desc(waitlistSignups.createdAt), desc(waitlistSignups.id));
      return rows.map((row) => ({
        ...common(row),
        nameInitial: row.nameInitial,
        emailMasked: row.emailMasked,
        phoneLast4: row.phoneLast4,
      }));
    },

    /** Signups per destination country (a signup with N countries counts once in each) + the total. */
    async countsByDestination(): Promise<WaitlistCounts> {
      const totalRes = await db.execute(sql`SELECT count(*)::int AS n FROM ${waitlistSignups}`);
      const total = Number((totalRes as unknown as { rows: { n: number | string }[] }).rows[0]?.n ?? 0);
      const perRes = await db.execute(
        sql`SELECT d AS country, count(*)::int AS n
              FROM ${waitlistSignups}, jsonb_array_elements_text(${waitlistSignups.destinations}) AS d
             GROUP BY d ORDER BY n DESC, d`,
      );
      const byCountry: Record<string, number> = {};
      for (const r of (perRes as unknown as { rows: { country: string; n: number | string }[] }).rows) {
        byCountry[r.country] = Number(r.n);
      }
      return { total, byCountry };
    },

    /** THE decrypting read — for the audited, admin-only CSV export. Decrypt failures throw (never a silent blank). */
    async listDecrypted(): Promise<WaitlistCsvRow[]> {
      const rows = await db.select().from(waitlistSignups).orderBy(desc(waitlistSignups.createdAt), desc(waitlistSignups.id));
      return rows.map((row) => ({
        ...common(row),
        fullName: decryptField(row.fullNameEnc, provider),
        email: decryptField(row.emailEnc, provider),
        phone: decryptField(row.phoneEnc, provider),
        location: decryptField(row.locationEnc, provider),
      }));
    },
  };
}
export type WaitlistRepo = ReturnType<typeof createWaitlistRepo>;
