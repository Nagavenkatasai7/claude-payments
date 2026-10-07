import { createFeatureFlagRepo, type FlagRow, type FlagScopeType } from '@/db/repos/feature-flag-repo';
import type { DbOrTx } from '@/db/client';
import { logWarn } from './log';

// flags — feature flags and kill switches (Release safety Batch 2 part A).
//
// One table (feature_flags, 0029), one row per (key, scope). A flag is ON for a
// request when ANY enabled row matches it: the global row, a row for one of the
// request's partners, or a row for its corridor (destination country). No row ⇒
// off, so an empty table is exactly the behaviour before this file existed.
//
// Reads are cached per server instance for FLAG_CACHE_TTL_MS, so a switch takes
// effect everywhere within that time without a deploy. The admin action clears
// the cache of the instance that served it at once.
//
// A failed read FAILS OPEN (the flag reads as off) with one log line: every
// caller of a kill switch also needs Neon for its own work, so a database outage
// stops that work anyway, and a flag outage must never stop money on its own.
//
// Sanctions screening is NOT a flag and never reads this module: it stays
// structurally on (CLAUDE.md architecture spine).
//
// New features (voice notes, purpose detection) add their key to
// FLAG_DEFINITIONS and call isFlagOn; the admin page lists every defined key.
// A beta feature also checks demo mode: only demo-mode phones (DEMO_PHONES,
// src/lib/demo-mode.ts) see it, whatever its switch says.

export const FLAG_CACHE_TTL_MS = 15_000;

export type FlagKey = 'sends.paused' | 'settlement.paused' | 'voice.notes' | 'purpose.detect';

export interface FlagDefinition {
  key: FlagKey;
  label: string;
  description: string;
  /** What staff see while it is on (the admin banner). */
  bannerText: string;
  scopes: readonly FlagScopeType[];
  /** A kill switch stops money movement: turning it ON sends an ops alert and shows the red banner. */
  killSwitch: boolean;
}

export const FLAG_DEFINITIONS: Readonly<Record<FlagKey, FlagDefinition>> = {
  'sends.paused': {
    key: 'sends.paused',
    label: 'Pause new sends',
    description:
      'No new transfer is created: the bot, the pay page, the portal, B2B invoices, scheduled sends and the partner API refuse. ' +
      'Transfers that already exist continue. Quotes still work. Sandbox (test key) transfers are not paused.',
    bannerText: 'New sends are paused',
    scopes: ['global', 'partner', 'corridor'],
    killSwitch: true,
  },
  'settlement.paused': {
    key: 'settlement.paused',
    label: 'Pause settlement',
    description:
      'No settlement instruction goes to a partner rail. Each queued instruction waits and is tried again after 5 minutes, ' +
      'without using a retry attempt. Payment capture, customer messages and the ledger continue.',
    bannerText: 'Settlement to partner rails is paused',
    scopes: ['global', 'partner', 'corridor'],
    killSwitch: true,
  },
  // Step 1 voice notes: the on/off switch. Voice also needs the Azure Speech
  // env settings and the sender among the demo-mode phones (DEMO_PHONES,
  // demo-mode.ts; voice-notes.ts).
  // Only the shared SmartRemit number (the default partner) takes voice notes,
  // so a partner row matters only for 'default'.
  'voice.notes': {
    key: 'voice.notes',
    label: 'Voice notes',
    description:
      'The WhatsApp bot listens to English voice notes (up to 30 seconds) from demo-mode phones (DEMO_PHONES) and answers in text. ' +
      'Off: a voice note gets the "please type" reply. Only the shared SmartRemit number takes voice notes.',
    bannerText: 'Voice notes are on',
    scopes: ['global', 'partner'],
    killSwitch: false,
  },
  // A3 purpose detection (Raj #17): the bot fills the transfer purpose from
  // what the customer says. Also needs the sender among the demo-mode phones
  // (DEMO_PHONES, demo-mode.ts); read once per agent turn for the routed tenant.
  'purpose.detect': {
    key: 'purpose.detect',
    label: 'Purpose detection',
    description:
      'When a customer says why they are sending (English or Hinglish, e.g. "maa ki dawai ke liye"), the bot records the purpose ' +
      'on the transfer. Only demo-mode phones (DEMO_PHONES). The purpose reaches the settlement instruction to the payout partner; ' +
      'staff and the partner see a suggested purpose code that is not confirmed.',
    bannerText: 'Purpose detection is on',
    scopes: ['global', 'partner'],
    killSwitch: false,
  },
};

export const FLAG_KEYS = Object.keys(FLAG_DEFINITIONS) as FlagKey[];

export function isKnownFlagKey(v: unknown): v is FlagKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FLAG_DEFINITIONS, v);
}

export interface FlagContext {
  /** The partner(s) the request touches (owner and, for settlement, the rail partner). */
  partnerId?: string | readonly (string | null | undefined)[] | null;
  /** The destination country code (the corridor). */
  corridor?: string | null;
}

type Snapshot = { at: number; rows: FlagRow[] };
// Keyed by the db handle so two handles (tests: one PGlite per worker) never share a snapshot.
const cache = new WeakMap<object, Snapshot>();

async function enabledRows(db: DbOrTx, now: number): Promise<FlagRow[]> {
  const hit = cache.get(db);
  if (hit && now - hit.at < FLAG_CACHE_TTL_MS) return hit.rows;
  const rows = await createFeatureFlagRepo(db).listEnabled();
  cache.set(db, { at: now, rows });
  return rows;
}

/** The enabled rows of `key` that match `ctx` (pure; exported for tests and the banner). */
export function matchingRows(rows: readonly FlagRow[], key: string, ctx: FlagContext = {}): FlagRow[] {
  const partners = new Set(
    (Array.isArray(ctx.partnerId) ? ctx.partnerId : [ctx.partnerId]).filter(
      (p): p is string => typeof p === 'string' && p !== '',
    ),
  );
  const corridor = (ctx.corridor ?? '').toUpperCase();
  return rows.filter((r) => {
    if (!r.enabled || r.key !== key) return false;
    if (r.scopeType === 'global') return true;
    if (r.scopeType === 'partner') return partners.has(r.scopeId);
    if (r.scopeType === 'corridor') return corridor !== '' && r.scopeId.toUpperCase() === corridor;
    return false;
  });
}

/**
 * True when `key` is on for this request. Never throws: a read failure logs one
 * line and answers false (fail open — see the header).
 */
export async function isFlagOn(
  db: DbOrTx,
  key: FlagKey,
  ctx: FlagContext = {},
  now: number = Date.now(),
): Promise<boolean> {
  try {
    return matchingRows(await enabledRows(db, now), key, ctx).length > 0;
  } catch (err) {
    logWarn('flags.read', err, { key });
    return false;
  }
}

/** Every enabled kill-switch row (for the admin banner). Never throws; [] on a read failure. */
export async function activeKillSwitches(db: DbOrTx, now: number = Date.now()): Promise<FlagRow[]> {
  try {
    return (await enabledRows(db, now)).filter((r) => isKnownFlagKey(r.key) && FLAG_DEFINITIONS[r.key].killSwitch);
  } catch (err) {
    logWarn('flags.read', err, { key: 'kill_switches' });
    return [];
  }
}

/** Drop this instance's cached snapshot (the switch action calls it after a write). */
export function invalidateFlagCache(db?: DbOrTx): void {
  if (db) cache.delete(db);
}

/**
 * Thrown by createTransferWithOutcome when `sends.paused` matches the mint.
 * NOTHING was read under the sender lock or written. Every mint caller maps it
 * to its own refusal (SENDS_PAUSED_MESSAGE for customers, HTTP 503 for the API).
 */
export class SendsPausedError extends Error {
  constructor() {
    super('sends_paused');
    this.name = 'SendsPausedError';
  }
}

/** Customer-facing text for a paused send (bot, pay page, portal). Keeps the product's style. */
export const SENDS_PAUSED_MESSAGE = 'Sending is paused for a short time. Your money is safe. Please try again later.';

/** The partner API's Retry-After (seconds) on a sends_paused 503. */
export const SENDS_PAUSED_RETRY_AFTER_SEC = 300;

/** How long a paused settlement.instruct row waits before the worker tries it again. */
export const SETTLEMENT_PAUSED_DEFER_SEC = 300;
