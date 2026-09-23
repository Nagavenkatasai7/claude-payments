import { decryptField } from '@/lib/field-crypto';
import { outboxSealedCtx } from '@/lib/crypto-context';

// sealed-text — renders `{{key}}` placeholders in a durable email payload from a
// map of field-crypto blobs. This is how the ONE outbox payload that must carry
// a capability (the partner-application invite link, fix 11 / F66) stays
// ciphertext at rest: the link is sealed with encryptField at ENQUEUE and opened
// here at SEND time. The token is minted exactly once (partners-action.ts) —
// never per attempt: setApplicationToken overwrites application_token_hash, so a
// re-mint on an at-least-once redelivery would kill the link already delivered.
//
// Pure, with an injectable opener so it is unit-tested without env. A missing
// blob throws a message naming the PLACEHOLDER only — it lands in
// outbox.last_error (sliced to 1000 chars), which the ops page renders.
//
// Program-Fix 46A: each placeholder opens under its purpose context
// (outboxSealedCtx — the same mapping partners-action seals with); a v2 blob
// opens only under the context it was sealed for. v1 blobs ignore the context
// and open as before.

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

export function renderSealedText(
  text: string,
  sealed: unknown,
  open: (blob: string, key: string) => string = (blob, key) =>
    decryptField(blob, undefined, outboxSealedCtx(key)),
): string {
  if (!sealed || typeof sealed !== 'object') return text;
  const map = sealed as Record<string, unknown>;
  return text.replace(PLACEHOLDER, (_whole, key: string) => {
    const blob = map[key];
    if (typeof blob !== 'string') {
      throw new Error(`sealed-text: no sealed value for {{${key}}}`);
    }
    return open(blob, key);
  });
}
