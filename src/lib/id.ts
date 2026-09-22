import { randomBytes } from 'node:crypto';

/**
 * Mint an opaque id (Program-Fix 23: authz-02 / crypto-13 / money-08 / F48).
 *
 * The value is a CAPABILITY: it is the unauthenticated `/pay/<id>` link, the
 * draft id, the rail reference, the funding-webhook key and the body of every
 * prefixed id (`inv_`, `s_`, `tk_`, `pk_`, …). So it comes from the OS CSPRNG
 * (`randomBytes`, `node:crypto` — @types/node crypto.d.ts:1896) and carries
 * 128 bits: 16 bytes as unpadded base64url, 22 characters of `[A-Za-z0-9_-]`
 * (`'base64url'` is a BufferEncoding — @types/node buffer.d.ts:256). No `:`,
 * `|` or `=`, so Redis keys (`recipient_draft:<id>`, `iprl|…`) and WhatsApp
 * button ids (`approve:<id>`) stay unambiguous, and the id needs no URL encoding.
 *
 * Compatibility: ids are opaque `text` primary keys. Pre-fix 8-character base36
 * ids resolve forever — no read path checks length or charset, and no CHECK
 * constraint is ever added. This is the one place the shape is decided.
 *
 * Node.js runtime only (`node:crypto`): never import from `src/middleware.ts`.
 */
export function newTransferId(): string {
  return randomBytes(16).toString('base64url');
}
