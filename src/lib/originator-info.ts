import type { DbOrTx } from '@/db/client';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { auditSubjectId } from './customer-ref';
import { logWarn } from './log';
import { readPayGateContext } from './pay-gate-context';
import { originatorDataMissing, travelRuleRequirement, type TravelRuleRequirement } from './travel-rule';
import type { CountryCode, PartnerId, Transfer } from './types';

/**
 * Fix pack 5 (P20, R38): the sender's travel-rule originator data, their home
 * address and date of birth. Server only. The values are sealed on the customer
 * row (customer-repo's set-if-unset setters) and never reach a log, an alert,
 * an audit meta, an outbox payload, a page prop or a bot/MCP result: only the
 * field NAMES ('address', 'date_of_birth') leave this module.
 */

export type OriginatorField = 'address' | 'date_of_birth';

export interface OriginatorWriteMeta {
  source: 'pay_page' | 'payment_link' | 'partner_api';
  transferId?: string;
  routeId?: string;
  /** The API key id, for source 'partner_api'. */
  actor?: string;
}

/**
 * ONE transaction (a nested savepoint when `db` is already a transaction): the
 * set-if-unset writes of the values given, plus ONE `customer.travel_rule_set`
 * audit row naming the fields written (P29: `{ source, fields, transferId?,
 * routeId? }`; subject auditSubjectId(owner)). A value already on file is never
 * replaced and is not in `fields`; nothing written -> no audit row and `[]`.
 * A failed audit insert throws and rolls the values back. It does not validate:
 * the caller ran the travel-rule validators first. Errors propagate (the caller
 * logs the error NAME only).
 */
export async function writeOriginatorInfo(
  db: DbOrTx,
  owner: { partnerId: PartnerId; phone: string },
  v: { address?: string; dateOfBirth?: string },
  meta: OriginatorWriteMeta,
): Promise<OriginatorField[]> {
  return db.transaction(async (tx) => {
    const repo = createCustomerRepo(tx, async () => null);
    const fields: OriginatorField[] = [];
    if (v.address && (await repo.setResidentialAddressIfUnset(owner.partnerId, owner.phone, v.address))) {
      fields.push('address');
    }
    if (v.dateOfBirth && (await repo.setDateOfBirthIfUnset(owner.partnerId, owner.phone, v.dateOfBirth))) {
      fields.push('date_of_birth');
    }
    if (fields.length > 0) {
      const api = meta.source === 'partner_api';
      await createAuditRepo(tx).record({
        partnerId: owner.partnerId,
        actor: api ? (meta.actor ?? 'api_key') : 'pay-page',
        actorType: api ? 'api_key' : 'system',
        action: 'customer.travel_rule_set',
        subjectId: auditSubjectId(owner.partnerId, owner.phone),
        meta: {
          source: meta.source,
          fields,
          ...(meta.transferId ? { transferId: meta.transferId } : {}),
          ...(meta.routeId ? { routeId: meta.routeId } : {}),
        },
      });
    }
    return fields;
  });
}

/**
 * Fix pack 5 (P22, C3): THE one predicate: settleOrHold and the releases
 * (T20b) and the worker's G16 (T23) import it; there is never a second copy.
 * True when the row is NOT exempt (originatorExempt: B2B or Partner-API-minted)
 * AND either it is routed (settlementPartnerId set: the originator data cannot
 * go to a routed rail) or the travel-rule band's data is not on file on the
 * OWNER's customer row (address always; date of birth by band, principal in
 * USD). Reads booleans only (never decrypts). It does not decide real money:
 * the caller does, and calls it only on a real-money row. A read error throws.
 */
export async function originatorInfoMissing(
  db: DbOrTx,
  t: Pick<Transfer, 'id' | 'partnerId' | 'phone' | 'settlementPartnerId' | 'destinationCountry' | 'amountUsd'>,
  // Fix pack 5 T23: the worker read the exemption once in its build step
  // (P22) and passes it, so the drain reads it once; absent -> read here.
  known: { exempt?: boolean } = {},
): Promise<boolean> {
  const exempt = known.exempt ?? (await createTransferRepo(db).originatorExempt(t.id, t.partnerId));
  if (exempt) return false;
  if (t.settlementPartnerId) return true;
  return originatorDataMissing(
    travelRuleRequirement({ destinationCountry: t.destinationCountry, amountUsd: t.amountUsd }),
    await createCustomerRepo(db, async () => null).originatorOnFile(t.partnerId, t.phone),
  );
}

/**
 * Fix pack 5 (P19): which originator fields the pay page asks and the pay
 * route accepts. Booleans only (never a value). A field is shown when
 * `required && !onFile`.
 */
export interface OriginatorView {
  addressRequired: boolean;
  addressOnFile: boolean;
  dobRequired: boolean;
  dobOnFile: boolean;
}

/** Nothing asked: not real money, b2b, exempt (Partner API) or routed. */
export const NO_ORIGINATOR_FIELDS: OriginatorView = Object.freeze({
  addressRequired: false,
  addressOnFile: true,
  dobRequired: false,
  dobOnFile: true,
}) as OriginatorView;

/**
 * The payment the view is for: the OWNER tenant and the sender's phone (the
 * customer row the values go to), the principal in USD and the destination
 * (the band), and, for a stored row, its id (the exemption read). `routed`:
 * the row (or draft) settles on another partner's rail (settlementPartnerId
 * set), so the data could never be sent: nothing is asked (the settle hold
 * catches the row, P12 fallback). Every caller passes it.
 */
export interface OriginatorSubject {
  partnerId: PartnerId;
  phone: string;
  amountUsd: number;
  destinationCountry: CountryCode | null | undefined;
  transferType: 'b2c' | 'b2b';
  transferId?: string;
  routed?: boolean;
}

/**
 * Fix pack 5 (P19, P21): the view for a payment whose real-money answer the
 * caller holds (`realMoneyForField`, pay-gate-context.ts). b2b, routed or not
 * real money -> NO_ORIGINATOR_FIELDS with no read; an exempt stored row
 * (originatorExempt) -> NO_ORIGINATOR_FIELDS. Else the band asks the address
 * always and the date of birth by amount and destination; on-file is an IS NOT
 * NULL test of the OWNER's customer row (never decrypted). Never throws: a
 * read error keeps required as computed (address true, DOB from the band) and
 * on-file false, and logs the error NAME with ids only.
 */
export async function originatorViewFor(
  db: DbOrTx,
  realMoneyForField: boolean,
  s: OriginatorSubject,
): Promise<OriginatorView> {
  if (!realMoneyForField || s.transferType === 'b2b' || s.routed) return NO_ORIGINATOR_FIELDS;
  let req: TravelRuleRequirement | null = null;
  try {
    if (s.transferId && (await createTransferRepo(db).originatorExempt(s.transferId, s.partnerId))) {
      return NO_ORIGINATOR_FIELDS;
    }
    req = travelRuleRequirement({ destinationCountry: s.destinationCountry, amountUsd: s.amountUsd });
    const onFile = await createCustomerRepo(db, async () => null).originatorOnFile(s.partnerId, s.phone);
    return {
      addressRequired: true,
      addressOnFile: onFile.address,
      dobRequired: req.dateOfBirth,
      dobOnFile: onFile.dateOfBirth,
    };
  } catch (err) {
    // The error NAME and ids only: never the phone, never a driver error object.
    logWarn('pay.originator-view', err instanceof Error ? err.name : 'error', {
      partnerId: s.partnerId,
      ...(s.transferId ? { transferId: s.transferId } : {}),
    });
    const band = req ?? travelRuleRequirement({ destinationCountry: s.destinationCountry, amountUsd: s.amountUsd });
    return { addressRequired: true, addressOnFile: false, dobRequired: band.dateOfBirth, dobOnFile: false };
  }
}

/**
 * Fix pack 5 (P19): the page wrapper: the pre-verify gate context of the
 * payment (readPayGateContext, never throws) then originatorViewFor. Never throws.
 */
export async function readOriginatorView(
  db: DbOrTx,
  i: {
    ownerId: PartnerId;
    railPartnerId: PartnerId;
    environment: 'live' | 'test' | undefined;
    transferType: 'b2c' | 'b2b';
    subject: OriginatorSubject;
  },
): Promise<OriginatorView> {
  const ctx = await readPayGateContext(db, {
    ownerId: i.ownerId,
    railPartnerId: i.railPartnerId,
    environment: i.environment,
    transferType: i.transferType,
  });
  return originatorViewFor(db, ctx.realMoneyForField, i.subject);
}
