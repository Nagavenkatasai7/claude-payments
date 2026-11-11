import type { DbOrTx } from '@/db/client';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { isFlagOn } from '@/lib/flags';
import { demoPhoneList, inDemo } from '@/lib/demo-mode';
import { capabilityOpen, isLiveCertified } from '@/lib/live-gate';
import type { PartnerId } from '@/lib/types';

// The AI-agent gate (Stage C1 spec item 4): the `agent.tools` switch for the HOST's tenant
// (global or that partner) AND the customer's phone in demo mode (DEMO_PHONES). FAILS CLOSED:
// isFlagOn already answers false on a read failure, and any other error is false here too.
// Fix pack 3 (R26): the `agent.tools.paused` kill switch (global, a platform partner row or
// the tenant's own `tenant:<id>` row) shuts the tools whatever `agent.tools` says. Its own
// read fails open (not paused), but then `agent.tools` cannot be read either, so the gate
// still answers false.
// Fix pack 3 (R13, contract 10): a tenant certified for live money also needs its AI-tools
// (`mcp`) capability opt-in (counsel ref + partner approval). The partner row is read only
// after both switches pass, never for the default tenant, on the DB directly
// (createPartnerRepo); a read failure answers false like every other error here.

/** Is the switch on (and not paused) for this tenant? (No phone: the pre-sign-in check and registration.) */
export async function agentToolsOn(db: DbOrTx, partnerId: PartnerId): Promise<boolean> {
  try {
    if (!(await isFlagOn(db, 'agent.tools', { partnerId }))) return false;
    if (await isFlagOn(db, 'agent.tools.paused', { partnerId })) return false;
    if (partnerId !== DEFAULT_PARTNER_ID) {
      const p = await createPartnerRepo(db).getPartner(partnerId);
      if (isLiveCertified(p) && !capabilityOpen(p, 'mcp')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The full gate for one customer. */
export async function agentGateOpen(db: DbOrTx, partnerId: PartnerId, phone: string, demoList?: readonly string[]): Promise<boolean> {
  try {
    if (!inDemo(phone, demoList ?? demoPhoneList())) return false;
    return await agentToolsOn(db, partnerId);
  } catch {
    return false;
  }
}
