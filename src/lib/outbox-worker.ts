import type { Db } from '@/db/client';
import { createOutboxRepo, type OutboxRepo, type OutboxRow } from '@/db/repos/outbox-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import {
  buildSettlementInstruction,
  signBody,
} from '@/lib/providers/http-payment-provider';
import { completePaymentStage2, recipientTemplateParams } from '@/lib/payment';
import { resolvePartnerBranding } from '@/lib/partner-config';
import { waCredsFrom } from '@/lib/whatsapp-creds';
import { env } from '@/lib/env';
import type { Store } from '@/lib/store';
import type { WaCreds } from '@/lib/whatsapp';

// outbox-worker — the durability engine (Stage 2b). Every external effect is an
// outbox row written transactionally with the state change that implies it;
// this worker drains them with retries → backoff → dead-letter (+ ops alert).
// Vercel after() is reduced to a best-effort POKE of /api/worker; the GitHub
// Actions 5-minute heartbeat is the delivery GUARANTEE.
//
// Handlers are dispatch-by-kind, DI'd so PGlite tests run them without any
// network. Every handler is IDEMPOTENT by construction (dedupe keys upstream +
// forward-only state machine downstream), so at-least-once delivery is safe.

export interface WorkerDeps {
  db: Db;
  store: Store;
  sendText: (to: string, text: string, creds?: WaCreds) => Promise<void>;
  sendTemplate: (
    to: string,
    template: string,
    lang: string,
    params: string[],
    creds?: WaCreds,
  ) => Promise<void>;
  fetchFn: typeof fetch;
  recipientTemplateName: string;
  recipientTemplateLang: string;
}

type Payload = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function partnerContext(deps: WorkerDeps, partnerId: string) {
  const partner = await createPartnerRepo(deps.db).getPartner(partnerId);
  const integrations = await createIntegrationsRepo(deps.db).getIntegrations(partnerId);
  return {
    brand: resolvePartnerBranding(partner).brand,
    waCreds: waCredsFrom(integrations),
    integrations,
  };
}

async function handle(deps: WorkerDeps, row: OutboxRow): Promise<void> {
  const p = row.payload as Payload;
  switch (row.kind) {
    // ── Plain customer-facing sends (the transactional message outbox) ──────
    case 'whatsapp.text': {
      const creds = p.creds as WaCreds | undefined;
      await deps.sendText(str(p.to), str(p.body), creds);
      return;
    }
    case 'whatsapp.template': {
      const creds = p.creds as WaCreds | undefined;
      await deps.sendTemplate(
        str(p.to),
        str(p.template),
        str(p.lang),
        (p.params as string[]) ?? [],
        creds,
      );
      return;
    }

    // ── The mock rail's stage 2 (was a 120s after() sleep — now durable) ────
    case 'mock.settle': {
      const transferId = str(p.transferId);
      const { brand, waCreds } = await partnerContext(deps, str(p.partnerId) || 'default');
      const stage2 = await completePaymentStage2(deps.store, transferId, { brand });
      for (const msg of stage2.senderMessages) {
        await deps.sendText(stage2.transfer.phone, msg, waCreds);
      }
      if (stage2.senderMessages.length > 0 && stage2.transfer.recipientPhone) {
        await deps.sendTemplate(
          stage2.transfer.recipientPhone,
          deps.recipientTemplateName,
          deps.recipientTemplateLang,
          recipientTemplateParams(stage2.transfer),
          waCreds,
        );
      }
      return;
    }

    // ── POST the SIGNED settlement instruction to the partner's rail ────────
    case 'settlement.instruct': {
      const transferId = str(p.transferId);
      const transferRepo = createTransferRepo(deps.db);
      const transfer = await transferRepo.getTransfer(transferId, { decrypt: true });
      if (!transfer) return; // gone ⇒ nothing to instruct (idempotent no-op)
      const { integrations } = await partnerContext(deps, transfer.partnerId);
      const settlementUrl = integrations.payment.credentials?.settlementUrl ?? '';
      const signingSecret = integrations.payment.credentials?.signingSecret ?? '';
      if (!settlementUrl) throw new Error('Settlement endpoint not configured.');
      const rawBody = JSON.stringify(buildSettlementInstruction(transfer));
      const res = await deps.fetchFn(settlementUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(signingSecret ? { 'x-signature': signBody(rawBody, signingSecret) } : {}),
        },
        body: rawBody,
      });
      if (!res.ok) {
        throw new Error(`Settlement instruction rejected (${res.status})`);
      }
      let providerRef = `rail-${transferId}`;
      try {
        const parsed = (await res.json()) as { providerRef?: unknown };
        if (typeof parsed.providerRef === 'string' && parsed.providerRef !== '') {
          providerRef = parsed.providerRef;
        }
      } catch {
        /* non-JSON 2xx ack — keep deterministic ref */
      }
      await transferRepo.setProviderRef(transferId, providerRef); // write-once
      return;
    }

    // ── The hosted reference rail's settle callback (was a 12s after()) ─────
    case 'rail.callback': {
      const reference = str(p.reference);
      const partnerId = str(p.partner_id) || str(p.partnerId);
      const { integrations } = await partnerContext(deps, partnerId);
      const webhookSecret = integrations.payment.webhookSecret ?? '';
      const callbackBody = JSON.stringify({ reference, status: 'paid_out' });
      const res = await deps.fetchFn(`${env.appBaseUrl}/api/payment-webhook/simulator`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(webhookSecret ? { 'x-signature': signBody(callbackBody, webhookSecret) } : {}),
        },
        body: callbackBody,
      });
      if (!res.ok) throw new Error(`Rail status callback rejected (${res.status})`);
      return;
    }

    // ── Stuck-money / dead-letter alerts to the ops phone ───────────────────
    case 'ops.alert': {
      const to = env.opsAlertPhone;
      if (!to) return; // unconfigured ⇒ drop silently (dashboard still shows it)
      await deps.sendText(to, str(p.message));
      return;
    }

    // 'agent.turn' lands in Stage 2c with the inbound pipeline change.
    default:
      throw new Error(`Unknown outbox kind: ${row.kind}`);
  }
}

export interface DrainResult {
  processed: number;
  failed: number;
  dead: number;
}

/** One drain pass: claim → execute → settle. Time-boxed by the caller. */
export async function drainOnce(
  deps: WorkerDeps,
  workerId: string,
  batchSize = 10,
): Promise<DrainResult> {
  const outbox: OutboxRepo = createOutboxRepo(deps.db);
  const rows = await outbox.claimBatch(batchSize, workerId);
  const result: DrainResult = { processed: 0, failed: 0, dead: 0 };
  for (const row of rows) {
    try {
      await handle(deps, row);
      await outbox.markDone(row.id);
      result.processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      const status = await outbox.markFailed(row.id, row.attempts, message);
      if (status === 'dead') {
        result.dead++;
        // Exactly one alert per dead row (dedupe key), never recursive.
        if (row.kind !== 'ops.alert') {
          await outbox.enqueue(
            'ops.alert',
            { message: `⚠️ SmartRemit ops: outbox #${row.id} (${row.kind}) DEAD after ${row.attempts} attempts: ${message.slice(0, 140)}` },
            { dedupeKey: `dead:${row.id}` },
          );
        }
      } else {
        result.failed++;
      }
    }
  }
  return result;
}
