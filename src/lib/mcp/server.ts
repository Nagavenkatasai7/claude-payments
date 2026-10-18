import { McpServer, requireScopes } from '@modelcontextprotocol/server';
import type { AgentPrincipal } from '@/lib/agent-auth';
import type { PortalOwner } from '@/lib/portal-transfers';
import { runGuardedTool, type GuardDeps } from './guard';
import {
  CANCEL_PREPARED_TRANSFER,
  PREPARE_TRANSFER,
  cancelPreparedTransferInput,
  cancelPreparedTransferTool,
  prepareTransferInput,
  prepareTransferTool,
} from './prepare';
import {
  CHECK_SEND_LIMIT,
  GET_QUOTE,
  GET_TRANSFER_STATUS,
  LIST_RECENT_TRANSFERS,
  LIST_RECIPIENTS,
  SERVER_INSTRUCTIONS,
  checkSendLimitInput,
  checkSendLimitTool,
  getQuoteInput,
  getQuoteTool,
  getTransferStatusInput,
  getTransferStatusTool,
  listRecentTransfersInput,
  listRecentTransfersTool,
  listRecipientsInput,
  listRecipientsTool,
  type McpDataDeps,
  type McpToolSpec,
} from './tools';

// Stage C1 (+ C2's prepare and cancel tools): ONE fresh McpServer per HTTP request (createMcpHandler's per-request factory), bound to
// the verified token's principal. The same instance shape serves both protocol eras (the SDK's
// modern 2026-07-28 path and its stateless legacy fallback for 2025-era clients).
//
// SDK APIs (installed @modelcontextprotocol/server 2.2.0):
// - new McpServer(serverInfo, options): dist/createMcpHandler-CfX6zgs1.d.mts:3255; ServerOptions
//   .instructions at :2834.
// - registerTool(name, { title, description, inputSchema, annotations, scopeChallenge }, cb):
//   :3361-3371 (a zod object is a StandardSchemaWithJSON, :1381).
// - requireScopes(...scopes): :2816. The serving entry answers a failing scope challenge with HTTP
//   403 + `WWW-Authenticate: Bearer error="insufficient_scope"` BEFORE the tool runs, on both eras
//   (dist/index.mjs:446-448 legacy transport, :1391-1394 modern; the response shape is
//   dist/mcp-DYuW2ZSs.mjs:555-561).

export const MCP_SERVER_INFO = { name: 'SmartRemit', version: '1.0.0' } as const;

export type McpServerDeps = GuardDeps & McpDataDeps;

/** Every C1 tool only reads, never changes anything, and touches only SmartRemit's own data. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** C2 prepare_transfer: makes a draft (nothing is paid); a retry with the same details returns the same one. */
const PREPARES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** C2 cancel_prepared_transfer: removes an unpaid draft; a second call finds nothing. */
const CANCELS = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

type Hints = typeof READ_ONLY | typeof PREPARES | typeof CANCELS;

function config(spec: McpToolSpec, hints: Hints = READ_ONLY) {
  return {
    title: spec.title,
    description: spec.description,
    annotations: { ...hints, title: spec.title },
    scopeChallenge: requireScopes(spec.scope),
  };
}

export function buildMcpServer(principal: AgentPrincipal, deps: McpServerDeps): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  // The ONLY identity a tool sees: the token's tenant and customer. Tool input never names either.
  const owner: PortalOwner = { partnerId: principal.partnerId, phone: principal.phone };
  const data: McpDataDeps = { toolDeps: deps.toolDeps, db: deps.db };
  const guard: GuardDeps = { auth: deps.auth, redis: deps.redis, now: deps.now };

  server.registerTool(GET_QUOTE.name, { ...config(GET_QUOTE), inputSchema: getQuoteInput }, (args) =>
    runGuardedTool(GET_QUOTE.name, principal, guard, () => getQuoteTool(owner, args, data)),
  );
  server.registerTool(CHECK_SEND_LIMIT.name, { ...config(CHECK_SEND_LIMIT), inputSchema: checkSendLimitInput }, () =>
    runGuardedTool(CHECK_SEND_LIMIT.name, principal, guard, () => checkSendLimitTool(owner, data)),
  );
  server.registerTool(LIST_RECIPIENTS.name, { ...config(LIST_RECIPIENTS), inputSchema: listRecipientsInput }, () =>
    runGuardedTool(LIST_RECIPIENTS.name, principal, guard, () => listRecipientsTool(owner, data)),
  );
  server.registerTool(LIST_RECENT_TRANSFERS.name, { ...config(LIST_RECENT_TRANSFERS), inputSchema: listRecentTransfersInput }, (args) =>
    runGuardedTool(LIST_RECENT_TRANSFERS.name, principal, guard, () => listRecentTransfersTool(owner, args, data)),
  );
  server.registerTool(GET_TRANSFER_STATUS.name, { ...config(GET_TRANSFER_STATUS), inputSchema: getTransferStatusInput }, (args) =>
    runGuardedTool(GET_TRANSFER_STATUS.name, principal, guard, () => getTransferStatusTool(owner, args, data)),
  );
  // Stage C2: prepare (a draft and its pay link) and cancel (an unpaid draft this app prepared).
  server.registerTool(PREPARE_TRANSFER.name, { ...config(PREPARE_TRANSFER, PREPARES), inputSchema: prepareTransferInput }, (args) =>
    runGuardedTool(PREPARE_TRANSFER.name, principal, guard, () =>
      prepareTransferTool(principal, args, { ...data, redis: deps.redis, now: deps.now }),
    ),
  );
  server.registerTool(
    CANCEL_PREPARED_TRANSFER.name,
    { ...config(CANCEL_PREPARED_TRANSFER, CANCELS), inputSchema: cancelPreparedTransferInput },
    (args) => runGuardedTool(CANCEL_PREPARED_TRANSFER.name, principal, guard, () => cancelPreparedTransferTool(principal, args, data)),
  );
  return server;
}
