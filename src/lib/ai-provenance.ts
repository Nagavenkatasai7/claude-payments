// ai-provenance: names the exact instructions a model saw (R31; R33 later
// stamps it on bot replies and transfers).
//
// promptHash(system, tools) = 'p1:' + sha256 hex of
//   system + NUL + JSON of the tool schemas with object keys sorted.
// Sorting keys makes the hash independent of how an object literal was
// written; array order is kept, because the model reads the tool list in
// order. The 'p1:' prefix versions the recipe: a different recipe gets a new
// prefix so old and new hashes are never compared as equal.
//
// Pure: no I/O. The hash identifies text; it is not a secret and holds no PII.
import { createHash } from 'node:crypto';
import type { ChatTool } from './types';

export const PROMPT_HASH_VERSION = 'p1';

/** JSON.stringify with object keys sorted at every depth (arrays keep their order). */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** The hash of the system prompt and the tool schemas exactly as the model receives them. */
export function promptHash(system: string, tools: readonly ChatTool[]): string {
  const digest = createHash('sha256').update(`${system}\u0000${stableJson(tools)}`, 'utf8').digest('hex');
  return `${PROMPT_HASH_VERSION}:${digest}`;
}
