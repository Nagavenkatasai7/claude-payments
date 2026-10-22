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
// SDK APIs (installed @modelcontextprotocol/server 2.3.1):
// - new McpServer(serverInfo, options): dist/createMcpHandler-D4NN8WsG.d.mts:3245; ServerOptions
//   .instructions at :2837; McpServerOptions.maxToolInputElements at :3230 (checked before schema
//   validation, dist/mcp-DIH4cS6P.mjs:1811).
// - registerTool(name, { title, description, inputSchema, annotations, scopeChallenge }, cb):
//   :3372-3395 (a zod object is a StandardSchemaWithJSON).
// - requireScopes(...scopes): :2819. The serving entry answers a failing scope challenge with HTTP
//   403 + `WWW-Authenticate: Bearer error="insufficient_scope"` BEFORE the tool runs, on both eras
//   (pinned by tests/mcp-route.test.ts "scopes"; the response shape is dist/mcp-DIH4cS6P.mjs:546).

export const MCP_SERVER_INFO = { name: 'SmartRemit', version: '1.0.0' } as const;

/**
 * GHSA-46jr-4wx8-v453: the SDK walks every array element and object member of tools/call arguments
 * while validating, so an oversized payload costs memory. Our largest input (prepare_transfer) has 7
 * flat fields and no arrays; 64 leaves room and refuses anything bigger before validation.
 */
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 64;

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
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS,
  });
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
