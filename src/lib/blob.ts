import { get, put } from '@vercel/blob';
import { env } from './env';

// blob — partner licence / KYB / AML documents in a PRIVATE Vercel Blob store
// (Program-Fix 24). The only file-upload path in the app.
//
// A stored document URL is NOT a capability: objects are written with
// `access: 'private'` (SDK 2.6.1, node_modules/@vercel/blob/dist/create-folder-DAlHaCQ2.d.ts:37-44),
// live on `<store>.private.blob.vercel-storage.com`, and need the store token on
// every read. The only read path is the audited staff route
// (admin-dashboard/partner-requests/[id]/documents/[index]/route.ts), which
// calls `streamPartnerDoc` server-side. Nothing here ever passes 'public'.
//
// The token is ALWAYS passed explicitly (`env.partnerDocsBlobToken`): the SDK
// resolves an explicit `token` before any OIDC / BLOB_STORE_ID / env branch
// (dist/chunk-CIIQSN42.js:169-172 `resolveBlobAuth`), so the old public store's
// still-connected BLOB_READ_WRITE_TOKEN can never be picked up by accident. If
// the private token is unset the helpers throw a FRIENDLY "not configured"
// error so callers degrade gracefully (uploads 503; the text application still
// submits) — there is no fallback to the public store.

export type PartnerDocType = 'application/pdf' | 'image/png' | 'image/jpeg';

/** The three document types the application accepts — the only types ever stored or served. */
export const PARTNER_DOC_TYPES: ReadonlySet<string> = new Set<PartnerDocType>([
  'application/pdf',
  'image/png',
  'image/jpeg',
]);

export function isPartnerDocType(value: string): value is PartnerDocType {
  return PARTNER_DOC_TYPES.has(value);
}

export interface UploadedDoc {
  url: string;
  pathname: string;
  size: number;
  contentType: PartnerDocType;
}

const NOT_CONFIGURED =
  'Document storage is not configured yet (PARTNER_DOCS_BLOB_READ_WRITE_TOKEN unset).';

function requireToken(): string {
  const token = env.partnerDocsBlobToken;
  if (!token) throw new Error(NOT_CONFIGURED);
  return token;
}

/** True when `err` is the friendly "not configured" error (callers map it to 503). */
export function isBlobNotConfigured(err: unknown): boolean {
  return err instanceof Error && err.message.includes('not configured');
}

/**
 * Upload one partner-application document to the PRIVATE store and return its
 * ref. `pathname` is the request-scoped key the upload route builds
 * (`partner-applications/<requestId>/…`); `contentType` is the SNIFFED type,
 * never the client's declaration. Throws the friendly error when unconfigured.
 */
export async function uploadPartnerDoc(
  file: Blob,
  pathname: string,
  contentType: PartnerDocType,
): Promise<UploadedDoc> {
  const token = requireToken();
  const result = await put(pathname, file, {
    access: 'private',
    addRandomSuffix: true,
    contentType,
    token,
  });
  return { url: result.url, pathname: result.pathname, size: file.size, contentType };
}

/**
 * Sniff a document's leading bytes (pure). PDF `%PDF-`, PNG
 * `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`; anything else (HTML, SVG, empty,
 * truncated) is null. The upload route requires this to EQUAL the declared type
 * and stores the sniffed value.
 */
export function sniffDocType(head: Uint8Array): PartnerDocType | null {
  const startsWith = (sig: number[]): boolean =>
    head.length >= sig.length && sig.every((b, i) => head[i] === b);
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  return null;
}

/** Host of a private Blob store: exactly one store-id label, then the fixed suffix. */
const PRIVATE_HOST = /^[a-z0-9]+\.private\.blob\.vercel-storage\.com$/;
/** Host of the OLD public store — only the migration script and the staff route's refusal know it. */
const PUBLIC_HOST = /^[a-z0-9]+\.public\.blob\.vercel-storage\.com$/;
/** Request ids are opaque `preq_<base64url>` text — nothing that needs escaping in a path. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]+$/;

/**
 * True only when `url` is an https URL on a PRIVATE Blob store host whose
 * pathname starts with `/partner-applications/<requestId>/` — the request the
 * token resolved. We PARSE with `new URL` and anchor on the hostname, so
 * `https://evil.com/?x=private.blob.vercel-storage.com`,
 * `…vercel-storage.com.evil.com`, the `@evil.com` userinfo form, `http:` and a
 * `..` traversal (normalised by the parser) all fail. One applicant can never
 * attach another's object; the staff route re-checks this before every read.
 */
export function isPrivatePartnerDocRef(url: string, requestId: string): boolean {
  if (!SAFE_REQUEST_ID.test(requestId)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (!PRIVATE_HOST.test(u.hostname)) return false;
  return u.pathname.startsWith(`/partner-applications/${requestId}/`);
}

/**
 * The ONE host our private token may ever be sent to, derived from the token
 * itself: a read-write token is `vercel_blob_rw_<storeId>_<secret>` and the SDK
 * builds `https://<storeId>.<access>.blob.vercel-storage.com/…` from it
 * (dist/chunk-CIIQSN42.js:119-122 `parseStoreIdFromReadWriteToken`, :338-339
 * `constructBlobUrl`). Null when the token is unset or not of that shape — then
 * no host is "ours" and nothing is read. Hostnames compare lower-case (the URL
 * parser lower-cases them).
 */
export function privateStoreHostFromToken(token: string): string | null {
  const storeId = token.split('_')[3] ?? '';
  if (!/^[A-Za-z0-9]+$/.test(storeId)) return null;
  return `${storeId.toLowerCase()}.private.blob.vercel-storage.com`;
}

/**
 * True only when `url` is https on EXACTLY the private store our token opens.
 * `isPrivatePartnerDocRef` pins the Vercel private-store domain and the request
 * prefix; this pins the store id, so a ref on someone else's private store —
 * valid shape, our request's prefix — is never handed to the SDK with our
 * bearer token. The staff route checks it before the audit row and
 * `streamPartnerDoc` checks it again where the token is actually sent.
 */
export function isOwnPrivateStoreRef(url: string): boolean {
  const host = privateStoreHostFromToken(env.partnerDocsBlobToken);
  if (!host) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname === host;
  } catch {
    return false;
  }
}

/** True when `url` parses to an https URL on the OLD public store (a not-yet-migrated ref). */
export function isLegacyPublicPartnerDocRef(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && PUBLIC_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

export interface PartnerDocStream {
  stream: ReadableStream<Uint8Array>;
  /** The content type the store recorded at put time (the sniffed one), allow-listed by the caller. */
  contentType: string;
  size: number;
}

/**
 * Read one private object for the audited staff route. Wraps
 * `get(url, { access: 'private', token })` (dist/index.d.ts:221; result union on
 * `statusCode` at :167-193) and returns null unless the store answered 200 with
 * a body. Throws the friendly error when unconfigured — never a fallback token.
 * Refuses (null, no SDK call) any url that is not on OUR store's host: the
 * token is sent to that host and nowhere else.
 */
export async function streamPartnerDoc(url: string): Promise<PartnerDocStream | null> {
  const token = requireToken();
  if (!isOwnPrivateStoreRef(url)) return null;
  const res = await get(url, { access: 'private', token });
  if (!res || res.statusCode !== 200 || !res.stream) return null;
  return { stream: res.stream, contentType: res.blob.contentType, size: res.blob.size };
}
