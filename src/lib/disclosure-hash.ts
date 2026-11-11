// disclosure-hash: fix pack 4 T5 (C11). The canonical hash of a partner's stored
// provider block (partners.support_config.disclosure), the value a partner
// admin's approval stamps (approval.hash) and the pay page will post back.
//
// disclosureHash(cfg) = 'dh1:' + sha256 hex of stableJson(cfg without its
// top-level 'approval' key). stableJson (ai-provenance.ts) sorts object keys at
// every depth, so jsonb's key reordering never changes the hash; array order is
// kept (licence ids are shown in order). The stamp itself is excluded, so
// stamping a block does not change the hash it stamps. The 'dh1:' prefix
// versions the recipe: a new recipe gets a new prefix.
//
// Server only (node:crypto). Pure: the hash names public provider details; it
// is not a secret and holds no customer PII. Never throws: the jsonb is untyped.
import { createHash } from 'node:crypto';
import { stableJson } from './ai-provenance';

export const DISCLOSURE_HASH_VERSION = 'dh1';

export function disclosureHash(cfg: unknown): string {
  let value: unknown = cfg;
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    const { approval: _approval, ...rest } = cfg as Record<string, unknown>;
    void _approval;
    value = rest;
  }
  return `${DISCLOSURE_HASH_VERSION}:${createHash('sha256').update(stableJson(value), 'utf8').digest('hex')}`;
}
