import type { DbOrTx } from '@/db/client';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { auditSubjectId } from './customer-ref';
import type { PartnerId } from './types';

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
