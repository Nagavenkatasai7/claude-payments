/**
 * Program-Fix 49B (prompt-11): the nightly real-model bot eval.
 *
 *   EVAL_ANTHROPIC_API_KEY=… npx tsx scripts/eval-bot.ts
 *
 * Runs the 24 recorded cases (scripts/eval-bot-cases.ts) once each against the
 * model and prints one line per case. It does NOTHING without
 * EVAL_ANTHROPIC_API_KEY: it prints a skip line and exits 0 before importing the
 * prompt or tool code, so CI without the secret is a no-op. It never gates a
 * merge: the Nightly workflow runs it with continue-on-error.
 *
 * Optional override (script-only, never read by the app):
 *   EVAL_ANTHROPIC_MODEL — default claude-haiku-5-5 (the production bot's
 *     model); claude-sonnet-5-5 checks the fallback model.
 *
 * The calls go through the app's own Claude adapter (src/lib/llm.ts createChat),
 * so the eval tests the exact request the bot sends. The key is sent only to
 * the Claude API and is never printed. Output carries case ids, titles and
 * failure reasons only.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatTool } from '@/lib/types';
import { createChat } from '@/lib/llm';
import { HAIKU } from '@/lib/llm-models';

export const EVAL_DEFAULT_MODEL = HAIKU;
/** Per call; 24 calls (8.8 min) stay inside the nightly step's 9-minute timeout. */
const EVAL_TIMEOUT_MS = 22_000;

type Env = Record<string, string | undefined>;
type FetchFn = typeof fetch;

/** The bot's chat call bound to the eval key (not the app's env). */
export function makeEvalChat(env: Env, fetchImpl: FetchFn = fetch) {
  const client = new Anthropic({ apiKey: env.EVAL_ANTHROPIC_API_KEY ?? '', maxRetries: 0, fetch: fetchImpl });
  const model = env.EVAL_ANTHROPIC_MODEL || EVAL_DEFAULT_MODEL;
  const chat = createChat({ client: () => client, agentModel: () => model });
  return (messages: ChatMessage[], tools: ChatTool[]): Promise<ChatMessage> =>
    chat(messages, tools, { task: 'agent', timeoutMs: EVAL_TIMEOUT_MS });
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
  if (!env.EVAL_ANTHROPIC_API_KEY) {
    log('eval-bot: skipped (EVAL_ANTHROPIC_API_KEY is not set)');
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
