import type { Db, DbOrTx } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo, createRecipientRepo } from '@/db/repos/aux-repos';
import { logWarn } from './log';
import { readPayGateContext } from './pay-gate-context';
import type { Draft, PartnerId, Transfer } from './types';

/**
 * Fix pack 4 (C18, R03): the recipient's account-holder name typed on the pay
 * page. Server only. The name itself never reaches a log, an audit meta or an
 * outbox payload: it is sealed only through the transfer and recipient repos
 * (C3, C4), and every log line here carries ids and an error name only.
 */

const errName = (err: unknown): string => (err instanceof Error ? err.name : 'error');

/**
 * ONE transaction: the fill-only guarded write (setRecipientLegalNameIfEditable:
 * this tenant's awaiting, unfunded, editable b2c row with no name yet) and its
 * `transfer.legal_name_set` audit row (C17: meta `{ source: 'pay_page' }` only).
 * False when a guard refused (nothing written). A failed audit insert throws and
 * rolls the name back. The audit partner is `t.partnerId`: the WHERE pins it.
 */
export async function writeRecipientLegalName(
  db: Db,
  t: Pick<Transfer, 'id' | 'partnerId'>,
  name: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const wrote = await createTransferRepo(tx).setRecipientLegalNameIfEditable(t.id, t.partnerId, name);
    if (wrote) {
      await createAuditRepo(tx).record({
        partnerId: t.partnerId,
        actor: 'pay-page',
        actorType: 'system',
        action: 'transfer.legal_name_set',
        subjectId: t.id,
        meta: { source: 'pay_page' },
      });
    }
    return wrote;
  });
}

export type PayLegalNameInput =
  | { transfer: Pick<Transfer, 'id' | 'partnerId'> }
  | { draft: Draft; ownerId: PartnerId; newBankFields: boolean };

/**
 * C18's "not needed" rule, one helper for the route and the page (T16):
 * - a minted transfer: a name on the row, or a row C19's hold exempts
 *   (Partner-API-minted, payment link, b2b) -> true;
 * - a draft: b2b -> true; else its own legal name, or (only when the request
 *   posts no new bank fields) the saved recipient's name for the SAME account
 *   the draft stores (C3 `match`).
 * Any read error -> false (the field is then required on real money); never throws.
 */
export async function payLegalNameOnFile(db: DbOrTx, i: PayLegalNameInput): Promise<boolean> {
  if ('transfer' in i) {
    try {
      return !(await createTransferRepo(db).recipientIdentityMissing(i.transfer.id, i.transfer.partnerId));
    } catch (err) {
      logWarn('pay.legal_name_read', errName(err), { transferId: i.transfer.id, partnerId: i.transfer.partnerId });
      return false;
    }
  }
  const { draft, ownerId, newBankFields } = i;
  if (draft.transferType === 'b2b') return true;
  if ((draft.recipientLegalName ?? '').trim() !== '') return true;
  const recipient = draft.recipient as Draft['recipient'] | undefined;
  if (newBankFields || !recipient?.recipientPhone) return false;
  try {
    const name = await createRecipientRepo(db).getRecipientLegalName(ownerId, draft.senderPhone, recipient.recipientPhone, {
      payoutMethod: recipient.payoutMethod,
      payoutDestination: (recipient.payoutDestination ?? '').trim(),
    });
    return (name ?? '').trim() !== '';
  } catch (err) {
    logWarn('pay.legal_name_read', errName(err), { partnerId: ownerId }); // a Draft carries no id of its own
    return false;
  }
}

/**
 * After a 2xx payment with a typed name: fill the saved recipient's EMPTY book
 * entry (live row only; never overwrites, never un-deletes). Best-effort: an
 * error is one warn with the transfer id; never throws.
 */
export async function fillRecipientBookLegalName(
  db: DbOrTx,
  t: Pick<Transfer, 'id' | 'partnerId' | 'phone' | 'recipientPhone'>,
  name: string,
): Promise<void> {
  try {
    await createRecipientRepo(db).fillRecipientLegalName(t.partnerId, t.phone, t.recipientPhone, name);
  } catch (err) {
    logWarn('pay.legal_name_book', errName(err), { transferId: t.id });
  }
}

export interface LegalNameView {
  legalNameRequired: boolean;
  legalNameOnFile: boolean;
}

/**
 * Fix pack 4 T16 (C18, C12): the pay PAGE's view of the account-holder field.
 * Two booleans only; a stored name never leaves this helper.
 * - b2b: never asked (`{ false, true }`, no read);
 * - a transfer minted through the Partner API or by a payment link: exempt,
 *   never asked (`{ false, true }`, critic M1);
 * - otherwise `legalNameOnFile` is C18's "not needed" rule for the STORED
 *   account (payLegalNameOnFile; a draft assumes no new bank fields), and
 *   `legalNameRequired` = C12's realMoneyForField ('required WHEN SHOWN').
 * Never throws: any read error gives onFile false and required from the
 * context (log `pay.page-legal-name`, error name and ids only).
 */
export async function readLegalNameView(
  db: DbOrTx,
  i: {
    ownerId: PartnerId;
    railPartnerId: PartnerId;
    environment: 'live' | 'test' | undefined;
    transferType: 'b2c' | 'b2b';
    transfer?: Pick<Transfer, 'id' | 'partnerId'>;
    draft?: Draft;
  },
): Promise<LegalNameView> {
  if (i.transferType === 'b2b') return { legalNameRequired: false, legalNameOnFile: true };
  // readPayGateContext never throws (a safe context on any unexpected error).
  const ctx = await readPayGateContext(db, {
    ownerId: i.ownerId,
    railPartnerId: i.railPartnerId,
    environment: i.environment,
    transferType: i.transferType,
  });
  const required = ctx.realMoneyForField === true;
  try {
    if (i.transfer) {
      const repo = createTransferRepo(db);
      const exempt = (await repo.isPartnerApiMinted(i.transfer.id)) || (await repo.isPaymentLinkTransfer(i.transfer.id));
      if (exempt) return { legalNameRequired: false, legalNameOnFile: true };
      const onFile = await payLegalNameOnFile(db, { transfer: { id: i.transfer.id, partnerId: i.transfer.partnerId } });
      return { legalNameRequired: required, legalNameOnFile: onFile === true };
    }
    if (i.draft) {
      const onFile = await payLegalNameOnFile(db, { draft: i.draft, ownerId: i.ownerId, newBankFields: false });
      return { legalNameRequired: required, legalNameOnFile: onFile === true };
    }
    return { legalNameRequired: required, legalNameOnFile: false };
  } catch (err) {
    logWarn('pay.page-legal-name', errName(err), {
      ...(i.transfer ? { transferId: i.transfer.id } : {}),
      partnerId: i.ownerId,
    });
    return { legalNameRequired: required, legalNameOnFile: false };
  }
}
