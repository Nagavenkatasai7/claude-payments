import { put } from '@vercel/blob';
import { env } from './env';

// blob — document uploads for the detailed partner application, via Vercel Blob.
// The only file-upload path in the app. Stores the partner's licence /
// incorporation / AML documents under a random, unguessable Blob URL (the URL is
// the capability — it carries a long random suffix). If BLOB_READ_WRITE_TOKEN is
// unset the helper throws a FRIENDLY error so the caller can degrade gracefully
// (the text application still submits; only uploads are gated).

export interface UploadedDoc {
  url: string;
  size: number;
  contentType: string;
}

/**
 * Upload one partner-application document to Vercel Blob and return its ref.
 * Throws a friendly error when uploads aren't configured yet.
 */
export async function uploadPartnerDoc(file: Blob, filename: string): Promise<UploadedDoc> {
  if (!env.blobReadWriteToken) {
    throw new Error('Document uploads are not configured yet (BLOB_READ_WRITE_TOKEN unset).');
  }
  const contentType = file.type || 'application/octet-stream';
  const result = await put(`partner-applications/${filename}`, file, {
    access: 'public', // capability URL — random unguessable suffix
    addRandomSuffix: true,
    contentType,
    token: env.blobReadWriteToken,
  });
  return { url: result.url, size: file.size, contentType };
}
