import type { DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { auditSubjectId } from '@/lib/customer-ref';
import { logWarn } from '@/lib/log';
import { normalizePhone } from '@/lib/phone';
import type { PartnerId } from '@/lib/types';

// Agent audit rows (Stage C1 spec item 8): `audit_events` with actor_type 'agent' (the column
// has no CHECK constraint), actor `agent:<client id>`, subject = auditSubjectId(partner, phone)
// (a keyed HMAC bound to the tenant, never the phone). Meta is flat primitives only and may never
// carry the phone or tool arguments. Best effort and time-bounded: an audit outage never changes
// what the customer or the app sees.

export type AgentAuditAction = 'agent.grant.created' | 'agent.grant.revoked' | 'agent.tool.called';

export interface AgentAuditInput {
  partnerId: PartnerId;
  phone: string;
  clientId: string;
  action: AgentAuditAction;
  meta?: Record<string, string | number | boolean>;
}

export const AGENT_AUDIT_TIMEOUT_MS = 1_500;
const FORBIDDEN_META_KEYS = new Set(['phone', 'token', 'code', 'secret', 'arguments', 'args', 'input']);

async function write(db: DbOrTx, e: AgentAuditInput): Promise<void> {
  const phone = normalizePhone(e.phone);
  if (!phone) throw new Error('agent audit: phone required');
  const meta = e.meta ?? {};
  for (const [k, v] of Object.entries(meta)) {
    if (FORBIDDEN_META_KEYS.has(k.toLowerCase())) throw new Error('agent audit: forbidden meta key');
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new Error('agent audit: meta must be primitives');
    if (normalizePhone(String(v)).includes(phone)) throw new Error('agent audit: meta carries the phone');
  }
  await createAuditRepo(db).record({
    partnerId: e.partnerId,
    actor: `agent:${e.clientId}`,
    actorType: 'agent',
    action: e.action,
    subjectId: auditSubjectId(e.partnerId, phone),
    ...(e.meta ? { meta } : {}),
  });
}

/** Writes one row. Never throws; gives up after AGENT_AUDIT_TIMEOUT_MS. The log line is fixed text. */
export async function recordAgentEvent(db: DbOrTx, e: AgentAuditInput, opts: { timeoutMs?: number } = {}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      write(db, e).then(() => 'ok' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), opts.timeoutMs ?? AGENT_AUDIT_TIMEOUT_MS);
      }),
    ]);
    if (outcome === 'timeout') logWarn('agent.audit', 'audit write timed out', { action: e.action });
  } catch {
    logWarn('agent.audit', 'audit write failed', { action: e.action });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
