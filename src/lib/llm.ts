import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
import type { ChatMessage, ChatTool } from './types';
import { ProviderHttpError, SPEND_CAP_ERROR_CODE } from './llm-provider-error';
import { llmTaskConfig, type LlmTask } from './llm-models';
import { fromAnthropicMessage, toAnthropicRequest } from './llm-translate';

// llm — the ONE seam every AI call goes through: the customer bot (agent.ts)
// and the staff helpers. It calls the Claude Messages API with the official
// TypeScript SDK (@anthropic-ai/sdk; types read from
// node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts and
// internal/request-options.d.ts). Callers keep the provider-neutral
// ChatMessage shape; llm-translate.ts converts both ways.
//
// Every request:
//  - runs in the US (`inference_geo: "us"`, 1.1x price; US-hosted vendors only);
//  - caches tools + the fixed system prompt (block breakpoint) and the chat so
//    far (top-level automatic breakpoint), so round 2 of a turn reads round 1;
//  - uses adaptive thinking at the task's effort (llm-models.ts);
//  - declares no server tools: the model can only call OUR tools.

/**
 * LLM call budget (bot-03). The agent's chatWithRetry (agent.ts) calls chat()
 * up to TWICE per round, so 2 × this must fit the worker's ROW_DEADLINE_MS
 * (40s). The SDK's own retries are off (maxRetries 0) so they never add a
 * third call past that deadline.
 */
export const LLM_TIMEOUT_MS = 20_000;

/** The slice of the SDK client chat() uses (tests pass a fake). */
export interface MessagesClient {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<Anthropic.Message>;
  };
}

export interface ChatOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Picks model + effort. Absent ⇒ 'agent' (the customer bot). */
  task?: LlmTask;
}

export type ChatFn = (messages: ChatMessage[], tools: ChatTool[], opts?: ChatOptions) => Promise<ChatMessage>;

function isOverloaded(err: unknown): boolean {
  return err instanceof ProviderHttpError && err.status === 529;
}

function errorCode(err: InstanceType<typeof Anthropic.APIError>): string | undefined {
  const body = err.error as { error?: { details?: { error_code?: unknown } } } | undefined;
  const code = body?.error?.details?.error_code;
  return typeof code === 'string' ? code : undefined;
}

/** Our own Console spend limit answers 400 with this message (rate-limits doc). */
const OWN_SPEND_LIMIT = /reached your specified (workspace )?API usage limits/i;

function toProviderError(err: InstanceType<typeof Anthropic.APIError>, status: number): ProviderHttpError {
  const code = errorCode(err);
  const spendCap = (status === 429 && code === SPEND_CAP_ERROR_CODE) || (status === 400 && OWN_SPEND_LIMIT.test(err.message));
  // Type + code + request id only: never the provider's message body.
  const detail = [err.type ?? 'error', code, err.requestID ? `request ${err.requestID}` : undefined].filter(Boolean).join(' ');
  return new ProviderHttpError(status, detail, { spendCap });
}

function logUsage(task: LlmTask, msg: Anthropic.Message, ms: number): void {
  // Numbers and enum values only: never prompt or reply text.
  const u = msg.usage;
  console.info(
    'llm.usage',
    JSON.stringify({
      task,
      model: msg.model,
      ms,
      stop: msg.stop_reason,
      in: u.input_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      out: u.output_tokens,
      geo: u.inference_geo ?? null,
    }),
  );
}

export function createChat(deps: { client: () => MessagesClient; agentModel?: () => string | undefined }): ChatFn {
  return async function chatImpl(messages, tools, opts = {}) {
    const task: LlmTask = opts.task ?? 'agent';
    const cfg = llmTaskConfig(task, { agentModel: deps.agentModel?.() });
    // A staff click (a copilot button) is not bound by the worker's row deadline
    // and may pass a longer timeoutMs; the agent keeps LLM_TIMEOUT_MS.
    const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
    // The caller's signal (the worker's row deadline, fix 7) is combined with
    // this call's own timeout: whichever fires first aborts the request. Both
    // models of one call share the same budget.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    const req = toAnthropicRequest(messages, tools);
    if (req.messages.length === 0) throw new Error('Model request has no user message');

    const send = async (model: string): Promise<ChatMessage> => {
      const started = Date.now();
      let res: Anthropic.Message;
      try {
        res = await deps.client().messages.create(
          {
            model,
            max_tokens: cfg.maxTokens,
            system: req.system,
            messages: req.messages,
            ...(req.tools.length > 0 ? { tools: req.tools } : {}),
            thinking: { type: 'adaptive' },
            output_config: { effort: cfg.effort },
            inference_geo: 'us',
            cache_control: { type: 'ephemeral' },
          },
          // The SDK timeout sits just past ours, so our clearer error wins.
          { signal, timeout: timeoutMs + 1_000 },
        );
      } catch (err) {
        // A deadline must be a CLEAR, catchable Error: chatWithRetry retries once
        // on OUR timeout, never on the caller's abort (the agent then degrades to
        // its friendly fallback — never a stuck turn, never a call past the row deadline).
        if (opts.signal?.aborted) throw new Error('Model request aborted by the caller (row deadline)');
        if (timeout.aborted || err instanceof Anthropic.APIConnectionTimeoutError) {
          throw new Error(`Model request timed out after ${timeoutMs}ms`);
        }
        if (err instanceof Anthropic.APIError && typeof err.status === 'number') throw toProviderError(err, err.status);
        throw err;
      }
      logUsage(task, res, Date.now() - started);
      if (res.stop_reason === 'refusal') {
        // A safety decline is a failed call: the agent retries once, then the fallback line.
        throw new Error(`Model declined the request (refusal: ${res.stop_details?.category ?? 'unknown'})`);
      }
      return fromAnthropicMessage(res);
    };

    try {
      return await send(cfg.model);
    } catch (err) {
      if (cfg.overloadFallbackModel && isOverloaded(err) && !signal.aborted) {
        console.warn(`llm: ${cfg.model} overloaded — one call on ${cfg.overloadFallbackModel}`);
        return await send(cfg.overloadFallbackModel);
      }
      throw err;
    }
  };
}

let client: Anthropic | null = null;

function defaultClient(): MessagesClient {
  // maxRetries 0: the agent owns the one retry (agent.ts chatWithRetry).
  client ??= new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 0 });
  return client;
}

/** Production chat: the Claude API with ANTHROPIC_API_KEY. */
export const chat: ChatFn = createChat({ client: defaultClient, agentModel: () => env.anthropicAgentModel });
