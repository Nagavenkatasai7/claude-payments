import type { DbOrTx } from '@/db/client';
import { env } from './env';
import { payFundingRefusal } from './funding-class';
import { logWarn } from './log';
import type { PayGateContext } from './pay-gate-context';
import { railSecrets, type PartnerFundingConfig, type PartnerIntegrations } from './partner-integrations';
import { getPartnerIntegrationsStore } from './partner-integrations-store';
import { alertUnrestrictedStripeKey } from './pay-process';
import { isRestrictedStripeKey } from './providers/funding-provider';
import type { PartnerId } from './types';

// fix pack 5 (P13, M5): the pre-verify copy of pay-process steps 5 and 7, so no
// code is spent and nothing is written before their 409; the pay-process steps
// stay authoritative.
//
// The pay and link routes call it at request_otp (no code is issued) and right
// after the pack 4 R18 pre-verify (before the account-holder rule, the
// originator rule and the code check). It runs only when the gate context
// KNOWS the rail is real money (`realMoneyKnown`): demo, simulator, mock,
// sandbox, the default tenant's mock rail and an unreadable rail type make no
// read and see no change (steps 5 and 7 still backstop them).
//
//   - the rail integrations read throws -> 'rail_unsigned' (fail closed);
//   - no current signing secret          -> 'rail_unsigned' (as step 5);
//   - the funding would be the mock      -> 'mock_on_real_money' (as step 7;
//     the funding config is read only with the Stripe flag on, a read that
//     throws counts as no config).
// Errors are logged by their NAME only (a driver error can carry the
// connection string); ids only, never a secret.
//
// `db` is the caller's handle, kept in the signature for the contract (P13);
// the reads go through the integrations store as pay-process's do.
export async function payMoneyGateRefusal(
  _db: DbOrTx,
  i: { ctx: PayGateContext; railPartnerId: PartnerId; subject: Parameters<typeof payFundingRefusal>[0] },
): Promise<'rail_unsigned' | 'mock_on_real_money' | null> {
  if (!i.ctx.realMoneyKnown) return null;
  const store = getPartnerIntegrationsStore();
  let integrations: PartnerIntegrations;
  try {
    integrations = await store.getIntegrations(i.railPartnerId);
  } catch (err) {
    logWarn('pay.money-gate', err instanceof Error ? err.name : 'error', { railPartnerId: i.railPartnerId });
    return 'rail_unsigned';
  }
  if (railSecrets(integrations.payment, 'signing', new Date()).length === 0) return 'rail_unsigned';

  let config: PartnerFundingConfig | null = null;
  if (env.stripeFundingEnabled) {
    try {
      config = await store.getFundingConfig(i.subject.partnerId);
    } catch (err) {
      logWarn('pay.funding-config', err instanceof Error ? err.name : 'error', { railPartnerId: i.railPartnerId });
    }
  }
  if (payFundingRefusal(i.subject, { realMoney: true, stripeEnabled: env.stripeFundingEnabled, config })) {
    // Fix pack 5 T16 (P16): the route refuses here before pay-process runs, so
    // a stored key that is not restricted raises the stripekey alert here too.
    if (config?.providerType === 'stripe' && !isRestrictedStripeKey(config.secretKey ?? '')) {
      await alertUnrestrictedStripeKey(i.subject.partnerId);
    }
    return 'mock_on_real_money';
  }
  return null;
}
