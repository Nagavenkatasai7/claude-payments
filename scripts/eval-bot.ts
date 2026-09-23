/**
 * Program-Fix 49B (prompt-11): the nightly real-model bot eval.
 *
 *   EVAL_OLLAMA_API_KEY=… npx tsx scripts/eval-bot.ts
 *
 * Runs the 15 recorded cases (scripts/eval-bot-cases.ts) once each against the
 * model and prints one line per case. It does NOTHING without
 * EVAL_OLLAMA_API_KEY: it prints a skip line and exits 0 before importing the
 * prompt or tool code, so CI without the secret is a no-op. It never gates a
 * merge: the Nightly workflow runs it with continue-on-error.
 *
 * Optional overrides (script-only, never read by the app):
 *   EVAL_OLLAMA_BASE_URL — default https://ollama.com/v1 (Ollama's
 *     OpenAI-compatible cloud endpoint: https://docs.ollama.com/api/openai-compatibility)
 *   EVAL_OLLAMA_MODEL    — default kimi-k2.6 (the production agent's model family)
 *
 * The key is sent only as the Authorization header to that endpoint and is
 * never printed. Output carries case ids, titles and failure reasons only.
 */
import type { ChatMessage, ChatTool } from '@/lib/types';

export const EVAL_DEFAULT_BASE_URL = 'https://ollama.com/v1';
export const EVAL_DEFAULT_MODEL = 'kimi-k2.6';
/** Per call; 15 calls stay inside the nightly step's 8-minute timeout. */
const EVAL_TIMEOUT_MS = 25_000;

type Env = Record<string, string | undefined>;
type FetchFn = typeof fetch;

/** An OpenAI-compatible chat call bound to the eval key (not the app's env). */
export function makeEvalChat(env: Env, fetchImpl: FetchFn = fetch) {
  const baseUrl = (env.EVAL_OLLAMA_BASE_URL || EVAL_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = env.EVAL_OLLAMA_MODEL || EVAL_DEFAULT_MODEL;
  const key = env.EVAL_OLLAMA_API_KEY ?? '';
  return async (messages: ChatMessage[], tools: ChatTool[]): Promise<ChatMessage> => {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
      signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`eval model HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: ChatMessage }[] };
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error('eval model returned no message');
    return message;
  };
}

/**
 * Exit code: 0 when skipped (no key) or every case passed, 1 otherwise.
 * `log` is injectable so the unit test can assert the skip line.
 */
export async function main(
  env: Env = process.env,
  fetchImpl: FetchFn = fetch,
  log: (line: string) => void = console.log,
): Promise<number> {
  if (!env.EVAL_OLLAMA_API_KEY) {
    log('eval-bot: skipped (EVAL_OLLAMA_API_KEY is not set)');
    return 0;
  }
  // Imported only past the key check: the skip path never loads the app graph.
  const { runEval, EVAL_CASES } = await import('./eval-bot-cases');
  const results = await runEval(makeEvalChat(env, fetchImpl), EVAL_CASES);
  let failed = 0;
  for (const r of results) {
    const ok = r.failures.length === 0;
    if (!ok) failed++;
    log(`${ok ? 'PASS' : 'FAIL'} #${r.id} ${r.title}${ok ? '' : ` — ${r.failures.join('; ')}`}${r.error ? ` (${r.error})` : ''}`);
  }
  log(`eval-bot: ${results.length - failed}/${results.length} passed`);
  return failed === 0 ? 0 : 1;
}

// Run only as a script (tsx), never when a test imports this module.
const invokedPath = process.argv[1] ?? '';
if (/eval-bot\.ts$/.test(invokedPath)) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`eval-bot: crashed (${err instanceof Error ? err.name : 'unknown'})`);
      process.exit(1);
    },
  );
}
