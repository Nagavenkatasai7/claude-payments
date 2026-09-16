import { env } from './env';
import type { ChatMessage, ChatTool } from './types';

/**
 * LLM call budget (bot-03). The agent's chatWithRetry (agent.ts) calls chat()
 * up to TWICE per round, so 2 × this must fit the worker's ROW_DEADLINE_MS
 * (40s). Kimi K2.6 on Ollama Cloud runs at a concurrency cap of 1-3; a call
 * that has not answered in 20s is queued behind something, and retrying is
 * cheaper than waiting.
 */
export const OLLAMA_TIMEOUT_MS = 20_000;

function isTimeout(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

export async function chat(
  messages: ChatMessage[],
  tools: ChatTool[],
  opts: { signal?: AbortSignal } = {},
): Promise<ChatMessage> {
  // The caller's signal (the worker's row deadline, fix 7) is combined with
  // this call's own timeout: whichever fires first aborts the fetch.
  // AbortSignal.any — node_modules/typescript/lib/lib.dom.d.ts:2787 (Node ≥20).
  const timeout = AbortSignal.timeout(OLLAMA_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  let res: Response;
  try {
    res = await fetch(`${env.ollamaBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.ollamaApiKey}`,
      },
      body: JSON.stringify({
        model: env.ollamaModel,
        messages,
        tools,
        tool_choice: 'auto',
      }),
      signal,
    });
  } catch (err) {
    // A deadline must be a CLEAR, catchable Error: chatWithRetry retries once
    // on OUR timeout, never on the caller's abort (the agent then degrades to
    // its friendly fallback — never a stuck turn, never a call past the row deadline).
    if (opts.signal?.aborted) throw new Error('Ollama request aborted by the caller (row deadline)');
    if (isTimeout(err)) throw new Error(`Ollama request timed out after ${OLLAMA_TIMEOUT_MS}ms`);
    throw err;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: ChatMessage }[];
  };
  // Guard the happy-path indexing: a missing/empty `choices` (a momentarily
  // malformed upstream response) must throw a CLEAR, catchable error rather than
  // a bare "cannot read properties of undefined" TypeError — the agent retries
  // chat() once and otherwise degrades to a friendly fallback.
  const message = data?.choices?.[0]?.message;
  if (!message) {
    throw new Error('Ollama response missing choices[0].message');
  }
  return message;
}
