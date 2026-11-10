import { randomUUID } from 'node:crypto';
import { createFeatureFlagRepo, type FlagScopeType } from '@/db/repos/feature-flag-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { getDb, type Db, type DbOrTx } from '@/db/client';
import {
  FLAG_DEFINITIONS,
  FLAG_KEYS,
  invalidateFlagCache,
  isKnownFlagKey,
  parseTenantScopeId,
  tenantScopeId,
  type FlagKey,
} from './flags';
import type { FlagRow } from '@/db/repos/feature-flag-repo';
import { parseDestinationCountry } from './destination-country';
import { requireStaffReason } from './send-limits';
import { sanctionsNoticeAddress } from './sanctions/notices';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { CountryCode, PartnerId, Staff } from './types';

// flag-switch — the ONE writer of feature_flags (Release safety part A). The
// /admin-dashboard/switches server action is a thin wrapper: it resolves the
// session (requirePlatformAdmin) and passes the staff record and the raw form
// fields here. Everything a public POST could forge is validated here, BEFORE
// any write:
//   • the caller is a PLATFORM admin (role admin, no partnerId) — re-checked,
//     never trusted from the wrapper alone;
//   • the key is a defined flag and the scope type is one it allows;
//   • a partner scope names an existing partner; a corridor scope a supported
//     destination country; a global scope has no id;
//   • the reason is at least 10 characters (bounded, cut at 500).
// Then ONE transaction writes the flag row, a `flag.change` audit row and, for a
// kill switch, one ops alert (so every staff member hears about a pause and its
// end). The calling instance's flag cache is cleared after the commit.
//
// Fix pack 3 (R26, contracts 11 and 13): partners set their OWN pauses through
// applyPartnerFlagChange below. Those rows are scope_type 'partner' with the
// scope id tenantScopeId() ('tenant:<id>[:<CC>]'). applyFlagChange refuses a
// 'tenant:' id (only the partner turns its own row off), and a CHANGED
// platform 'partner' row emails that partner (never 'default').

export const FLAG_AUDIT_ACTION = 'flag.change';

/**
 * Every message a FlagChangeError can carry (fixed text). The switches page shows
 * an `?error=` value ONLY when it is in this list, so the URL can never inject text.
 */
export const FLAG_CHANGE_MESSAGES: readonly string[] = [
  'Only a platform admin can change a switch.',
  'Unknown switch.',
  'Choose a valid scope.',
  'Choose an existing partner.',
  'Choose a supported destination country.',
  'Choose on or off.',
  'A reason is required.',
  'The reason must be at least 10 characters.',
  'Partner-set switches are changed in the partner workspace.',
];

export function isFlagChangeMessage(v: unknown): v is string {
  return typeof v === 'string' && FLAG_CHANGE_MESSAGES.includes(v);
}

export class FlagChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlagChangeError';
  }
}

export interface FlagChangeInput {
  key: unknown;
  scopeType: unknown;
  scopeId: unknown;
  enabled: unknown;
  reason: unknown;
}

export interface FlagChangeDeps {
  db: Db;
  /** Does this partner id exist? (the partner store, in production) */
  partnerExists: (id: string) => Promise<boolean>;
}

export interface FlagChangeResult {
  key: FlagKey;
  scopeType: FlagScopeType;
  scopeId: string;
  enabled: boolean;
  previous: boolean;
}

const SCOPE_TYPES: readonly FlagScopeType[] = ['global', 'partner', 'corridor'];

function parseEnabled(v: unknown): boolean {
  if (v === true || v === 'on' || v === 'true') return true;
  if (v === false || v === 'off' || v === 'false') return false;
  throw new FlagChangeError('Choose on or off.');
}

/** The keys a partner may set for its own tenant (contract 10 partnerOperable). */
export const PARTNER_FLAG_KEYS: readonly FlagKey[] = Object.freeze(FLAG_KEYS.filter((k) => FLAG_DEFINITIONS[k].partnerOperable));

/** Human scope label for alerts and the page (never a phone or a secret). */
export function scopeLabel(scopeType: FlagScopeType, scopeId: string): string {
  if (scopeType === 'global') return 'all partners and corridors';
  if (scopeType === 'partner') {
    const t = parseTenantScopeId(scopeId);
    if (t) return `set by partner ${t.partnerId}${t.corridor ? ` for ${t.corridor}` : ''}`;
    return `partner ${scopeId}`;
  }
  return `corridor ${scopeId}`;
}

function isActiveKillSwitch(r: FlagRow): r is FlagRow & { key: FlagKey } {
  return r.enabled && isKnownFlagKey(r.key) && FLAG_DEFINITIONS[r.key].killSwitch;
}

/** One line per enabled kill-switch row, for the red admin banner (pure). */
export function killSwitchBannerLines(rows: readonly FlagRow[]): string[] {
  return rows.filter(isActiveKillSwitch).map((r) => {
    const text = FLAG_DEFINITIONS[r.key].bannerText;
    const tenantRow = r.scopeType === 'partner' && parseTenantScopeId(r.scopeId) !== null;
    return `${text}${tenantRow ? ', ' : ' for '}${scopeLabel(r.scopeType, r.scopeId)}.`;
  });
}

/**
 * The partner workspace banner: one line per enabled kill-switch row that
 * touches `partnerId` (pure, fixed English; T11 may wrap it in i18n). It says
 * WHO set the row and never shows a reason or a username.
 */
export function partnerKillSwitchBannerLines(rows: readonly FlagRow[], partnerId: PartnerId): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (!isActiveKillSwitch(r)) continue;
    const text = FLAG_DEFINITIONS[r.key].bannerText;
    if (r.scopeType === 'global') {
      out.push(`${text} for every partner (set by SmartRemit).`);
    } else if (r.scopeType === 'corridor') {
      out.push(`${text} for corridor ${r.scopeId} (set by SmartRemit).`);
    } else if (r.scopeType === 'partner') {
      const t = parseTenantScopeId(r.scopeId);
      if (t) {
        if (t.partnerId !== partnerId) continue;
        out.push(`${text} for your workspace${t.corridor ? ` for ${t.corridor}` : ''} (set by your team).`);
      } else if (!r.scopeId.startsWith('tenant:') && r.scopeId === partnerId) {
        out.push(`${text} for your workspace (set by SmartRemit).`);
      }
    }
  }
  return out;
}

/**
 * Contract 13: the partner email for a changed partner row, on `tx`. None for
 * the 'default' tenant or a partner without a valid address. Ids and the
 * fixed label only (never the reason).
 */
async function enqueueFlagMail(
  tx: DbOrTx,
  partnerId: PartnerId,
  key: FlagKey,
  scopeId: string,
  enabled: boolean,
  who: 'your team' | 'SmartRemit',
): Promise<void> {
  if (partnerId === DEFAULT_PARTNER_ID) return;
  const p = await createPartnerRepo(tx).getPartner(partnerId);
  const to = sanctionsNoticeAddress(p?.supportConfig);
  if (!to) return;
  await createOutboxRepo(tx).enqueue(
    'email.send',
    {
      to: [to],
      subject: 'SmartRemit: a live control changed for your workspace',
      text: `${FLAG_DEFINITIONS[key].label} was changed by ${who} (${enabled ? 'turned on' : 'turned off'}). Details are in your SmartRemit workspace.`,
    },
    { dedupeKey: `flagmail:${key}:${scopeId}:${randomUUID()}` },
  );
}

export async function applyFlagChange(
  staff: Pick<Staff, 'username' | 'role' | 'partnerId'>,
  input: FlagChangeInput,
  deps: FlagChangeDeps,
): Promise<FlagChangeResult> {
  if (staff.role !== 'admin' || staff.partnerId !== undefined) {
    throw new FlagChangeError('Only a platform admin can change a switch.');
  }
  if (!isKnownFlagKey(input.key)) throw new FlagChangeError('Unknown switch.');
  const key = input.key;
  const def = FLAG_DEFINITIONS[key];

  const scopeType = String(input.scopeType ?? '') as FlagScopeType;
  if (!SCOPE_TYPES.includes(scopeType) || !def.scopes.includes(scopeType)) {
    throw new FlagChangeError('Choose a valid scope.');
  }

  if (scopeType === 'partner' && String(input.scopeId ?? '').trim().startsWith('tenant:')) {
    throw new FlagChangeError('Partner-set switches are changed in the partner workspace.');
  }

  let scopeId = '';
  if (scopeType === 'partner') {
    scopeId = String(input.scopeId ?? '').trim();
    if (scopeId === '' || scopeId.length > 100 || !(await deps.partnerExists(scopeId))) {
      throw new FlagChangeError('Choose an existing partner.');
    }
  } else if (scopeType === 'corridor') {
    const c = parseDestinationCountry(input.scopeId);
    if (!c) throw new FlagChangeError('Choose a supported destination country.');
    scopeId = c;
  }

  const enabled = parseEnabled(input.enabled);
  let reason: string;
  try {
    reason = requireStaffReason(input.reason);
  } catch (e) {
    const m = e instanceof Error ? e.message : '';
    throw new FlagChangeError(isFlagChangeMessage(m) ? m : 'A reason is required.');
  }

  const result = await deps.db.transaction(async (tx) => {
    const flags = createFeatureFlagRepo(tx);
    const before = await flags.get(key, scopeType, scopeId);
    const previous = before?.enabled ?? false;
    await flags.upsert({ key, scopeType, scopeId, enabled, reason, updatedBy: staff.username });
    await createAuditRepo(tx).record({
      partnerId: scopeType === 'partner' ? scopeId : undefined,
      actor: staff.username,
      actorType: 'staff',
      action: FLAG_AUDIT_ACTION,
      subjectId: `${key}:${scopeType}:${scopeId}`,
      meta: { key, scopeType, scopeId, enabled, previous, reason },
    });
    if (def.killSwitch && previous !== enabled) {
      // Fixed text: the key label, the scope, the actor and the reason (staff
      // typed, bounded). One row per change (a unique dedupe key).
      await createOutboxRepo(tx).enqueue(
        'ops.alert',
        {
          message:
            `${enabled ? '🛑' : '✅'} SmartRemit ops: "${def.label}" is now ${enabled ? 'ON' : 'OFF'} for ` +
            `${scopeLabel(scopeType, scopeId)} (by ${staff.username}). Reason: ${reason}`,
        },
        { dedupeKey: `flag:${key}:${scopeType}:${scopeId}:${randomUUID()}` },
      );
    }
    if (scopeType === 'partner' && previous !== enabled) {
      await enqueueFlagMail(tx, scopeId, key, scopeId, enabled, 'SmartRemit');
    }
    return { key, scopeType, scopeId, enabled, previous };
  });
  invalidateFlagCache(deps.db);
  return result;
}

export type PartnerFlagChangeCode = 'not_operable' | 'bad_corridor' | 'reason';

/**
 * Fix pack 3 (R26, contract 11): a partner sets or clears a pause for its OWN
 * tenant. The session tenant (`actor.partnerId`) is the only scope: nothing in
 * `i` can name another tenant or a platform scope. Only PARTNER_FLAG_KEYS; a
 * corridor only for a key with tenantCorridor. Refusals write nothing.
 *
 * ONE transaction: the 'partner' row `tenant:<id>[:<CC>]`, the `flag.change`
 * audit row (actorScope 'partner'; the reason lives only there) and, when the
 * state changed, one ops alert (ids only) and the partner email (contract 13).
 * The calling instance's flag cache is cleared after the commit.
 *
 * The caller (T11's partner action) gates the session (PARTNER_ADMIN, MFA,
 * step-up on a resume) and pokes the worker after this returns.
 */
export async function applyPartnerFlagChange(
  actor: { username: string; partnerId: PartnerId },
  i: { key: string; corridor?: string; enabled: boolean; reason: string },
): Promise<{ ok: true; changed: boolean } | { ok: false; code: PartnerFlagChangeCode }> {
  const rawKey: unknown = i.key;
  if (typeof rawKey !== 'string' || !(PARTNER_FLAG_KEYS as readonly string[]).includes(rawKey)) {
    return { ok: false, code: 'not_operable' };
  }
  const key = rawKey as FlagKey;
  const def = FLAG_DEFINITIONS[key];

  let corridor: CountryCode | undefined;
  const rawCorridor: unknown = i.corridor;
  if (rawCorridor !== undefined && rawCorridor !== null && String(rawCorridor).trim() !== '') {
    const c = parseDestinationCountry(rawCorridor);
    if (!c || !def.tenantCorridor) return { ok: false, code: 'bad_corridor' };
    corridor = c;
  }

  let reason: string;
  try {
    reason = requireStaffReason(i.reason);
  } catch {
    return { ok: false, code: 'reason' };
  }

  const partnerId = actor.partnerId;
  if (typeof partnerId !== 'string') return { ok: false, code: 'not_operable' };
  const scopeId = tenantScopeId(partnerId, corridor);
  const parsed = parseTenantScopeId(scopeId);
  if (!parsed || parsed.partnerId !== partnerId) return { ok: false, code: 'not_operable' };

  const enabled = i.enabled === true;
  const db = getDb();
  const changed = await db.transaction(async (tx) => {
    const flags = createFeatureFlagRepo(tx);
    const before = await flags.get(key, 'partner', scopeId);
    const previous = before?.enabled ?? false;
    await flags.upsert({ key, scopeType: 'partner', scopeId, enabled, reason, updatedBy: actor.username });
    await createAuditRepo(tx).record({
      partnerId,
      actor: actor.username,
      actorType: 'staff',
      action: FLAG_AUDIT_ACTION,
      subjectId: `${key}:partner:${scopeId}`,
      meta: { key, scopeType: 'partner', scopeId, corridor: corridor ?? null, enabled, previous, reason, actorScope: 'partner' },
    });
    if (previous === enabled) return false;
    // Ids and the fixed label only: never the reason.
    await createOutboxRepo(tx).enqueue(
      'ops.alert',
      {
        message:
          `${enabled ? '🛑' : '✅'} SmartRemit ops: "${def.label}" is now ${enabled ? 'ON' : 'OFF'}, ` +
          `set by partner ${partnerId} (by ${actor.username}).`,
      },
      { dedupeKey: `flag:${key}:partner:${scopeId}:${randomUUID()}` },
    );
    await enqueueFlagMail(tx, partnerId, key, scopeId, enabled, 'your team');
    return true;
  });
  invalidateFlagCache(db);
  return { ok: true, changed };
}
