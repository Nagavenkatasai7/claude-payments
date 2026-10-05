import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import type { DbOrTx } from '@/db/client';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { Store } from './store';
import type { Transfer } from './types';

/**
 * Step 0 Q16 (build-changes B.2): the transfer a draft pay link BECAME.
 *
 * A /pay/<draftId> link mints its transfer at pay time under a NEW id, bound
 * claim-first to the idempotency key `draft:<draftId>` under DEFAULT_PARTNER_ID
 * (pay-finalize.ts), and the draft is consumed right after the mint. When the
 * capture then fails (402), the customer's link must continue on that
 * transfer, not die. Callers use this only when neither a draft nor a transfer
 * with the link's id exists. Null when the draft never minted (or the claim is
 * bound but its mint never landed).
 *
 * The `draft:` prefix under the default tenant is written ONLY by
 * pay-finalize: the partner API refuses it at its edge
 * (partner-api-service.ts, reserved Idempotency-Key prefixes), so this lookup
 * can never land on a partner's transfer. Read-only.
 */
export async function transferMintedFromDraft(
  db: DbOrTx,
  store: Pick<Store, 'getTransfer'>,
  draftId: string,
): Promise<Transfer | null> {
  const id = await createIdempotencyRepo(db).find(DEFAULT_PARTNER_ID, `draft:${draftId}`);
  return id ? store.getTransfer(id) : null;
}
