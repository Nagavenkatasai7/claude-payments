import { randomUUID } from 'node:crypto';
import { createFeatureFlagRepo, type FlagScopeType } from '@/db/repos/feature-flag-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { Db } from '@/db/client';
import { FLAG_DEFINITIONS, invalidateFlagCache, isKnownFlagKey, type FlagKey } from './flags';
import type { FlagRow } from '@/db/repos/feature-flag-repo';
import { parseDestinationCountry } from './destination-country';
import { requireStaffReason } from './send-limits';
import type { Staff } from './types';

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

/** Human scope label for alerts and the page (never a phone or a secret). */
export function scopeLabel(scopeType: FlagScopeType, scopeId: string): string {
  if (scopeType === 'global') return 'all partners and corridors';
  if (scopeType === 'partner') return `partner ${scopeId}`;
  return `corridor ${scopeId}`;
}

/** One line per enabled kill-switch row, for the red admin banner (pure). */
export function killSwitchBannerLines(rows: readonly FlagRow[]): string[] {
  return rows
    .filter((r) => r.enabled && isKnownFlagKey(r.key) && FLAG_DEFINITIONS[r.key].killSwitch)
    .map((r) => `${FLAG_DEFINITIONS[r.key as FlagKey].bannerText} for ${scopeLabel(r.scopeType, r.scopeId)}.`);
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
    return { key, scopeType, scopeId, enabled, previous };
  });
  invalidateFlagCache(deps.db);
  return result;
}
