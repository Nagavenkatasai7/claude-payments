import type { DbOrTx } from '@/db/client';
import { isFlagOn } from '@/lib/flags';
import { demoPhoneList, inDemo } from '@/lib/demo-mode';
import type { PartnerId } from '@/lib/types';

// The AI-agent gate (Stage C1 spec item 4): the `agent.tools` switch for the HOST's tenant
// (global or that partner) AND the customer's phone in demo mode (DEMO_PHONES). FAILS CLOSED:
// isFlagOn already answers false on a read failure, and any other error is false here too.

/** Is the switch on for this tenant? (No phone: the pre-sign-in check and registration.) */
export async function agentToolsOn(db: DbOrTx, partnerId: PartnerId): Promise<boolean> {
  try {
    return await isFlagOn(db, 'agent.tools', { partnerId });
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
