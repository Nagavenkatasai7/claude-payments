import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVAL_CASES,
  PR_SUBSET_IDS,
  casesFor,
  runEval,
  replyExcerpt,
  EVAL_EXCERPT_MAX,
  type ChatFn,
  type EvalCase,
} from '../../scripts/eval-bot-cases';
import { main, makeEvalChat, EVAL_DEFAULT_MODEL, parseEvalConfig, requiredPasses, reportBaseName } from '../../scripts/eval-bot';
import { AGENT_MODEL_CHOICES, HAIKU, SONNET } from '@/lib/llm-models';
import type { ChatMessage } from '@/lib/types';

// Program-Fix 49B (prompt-11) and R31. No real model is ever called here:
// every chat function is a stub, and fetch is a spy that answers like the
// Claude API.

afterEach(() => vi.restoreAllMocks());

const claudeReply = (text: string, model = EVAL_DEFAULT_MODEL) =>
  new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model,
      content: text ? [{ type: 'text', text }] : [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers as HeadersInit | undefined).get(name);
}
const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as { model: string; inference_geo: string };

const KEY = 'test-key-not-real';
/** One model and one run, as the plan pins for the unit tests. */
const ONE = { EVAL_ANTHROPIC_API_KEY: KEY, EVAL_MODELS: HAIKU, EVAL_RUNS: '1' };
const blockingCount = EVAL_CASES.filter((c) => !c.pending).length;

const spyFetch = (text = '') => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => claudeReply(text));
const asFetch = (f: unknown) => f as typeof fetch;

/** A synthetic case whose check passes on the given run numbers only (1-based, per model). */
function scripted(id: number, passOn: number[], extra: Partial<EvalCase> = {}): EvalCase {
  let n = 0;
  return {
    id,
    title: `scripted ${id}`,
    category: 'flow',
    lang: 'en',
    history: [{ role: 'user', content: `case ${id}` }],
    check: () => {
      n += 1;
      return passOn.includes(n) ? [] : [`scripted failure on run ${n}`];
    },
    recorded: { pass: { role: 'assistant', content: 'p' }, fail: { role: 'assistant', content: 'f' } },
    ...extra,
  };
}

describe('eval-bot main(): key handling', () => {
  it('is a no-op without EVAL_ANTHROPIC_API_KEY: exit 0, a skip line, no network', async () => {
    const fetchSpy = vi.fn();
    const lines: string[] = [];
    const code = await main({}, asFetch(fetchSpy), (l) => lines.push(l));
    expect(code).toBe(0);
    expect(lines).toEqual(['eval-bot: skipped (EVAL_ANTHROPIC_API_KEY is not set)']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('EVAL_REQUIRED=1 without a key: exit 2, a FAILED line, no network', async () => {
    const fetchSpy = vi.fn();
    const lines: string[] = [];
    const code = await main({ EVAL_REQUIRED: '1' }, asFetch(fetchSpy), (l) => lines.push(l));
    expect(code).toBe(2);
    expect(lines).toEqual(['eval-bot: FAILED (EVAL_ANTHROPIC_API_KEY is not set and EVAL_REQUIRED=1)']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a bad setting is a FAILED line and exit 2, before any call', async () => {
    for (const bad of [{ EVAL_RUNS: '0' }, { EVAL_RUNS: 'three' }, { EVAL_SUBSET: 'some' }, { EVAL_MODELS: 'claude-opus-5-5' }, { EVAL_REQUIRED: 'yes' }]) {
      const fetchSpy = vi.fn();
      const lines: string[] = [];
      expect(await main({ EVAL_ANTHROPIC_API_KEY: KEY, ...bad }, asFetch(fetchSpy), (l) => lines.push(l)), JSON.stringify(bad)).toBe(2);
      expect(lines[0]).toMatch(/^eval-bot: FAILED \(/);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });
});

describe('eval-bot main(): runs the cases against the Claude API', () => {
  it('with a key it runs every case once per model and run, and never prints the key', async () => {
    const fetchSpy = spyFetch('');
    const lines: string[] = [];
    const code = await main(ONE, asFetch(fetchSpy), (l) => lines.push(l));
    expect(fetchSpy).toHaveBeenCalledTimes(EVAL_CASES.length);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    expect(headerOf(init, 'x-api-key')).toBe(KEY);
    expect(bodyOf(init).model).toBe(HAIKU);
    expect(bodyOf(init).inference_geo).toBe('us');
    expect(lines.join('\n')).not.toContain(KEY);
    expect(lines.at(-1)).toMatch(new RegExp(`^eval-bot: \\d+/${blockingCount} passed; pending \\d+/\\d+ \\(not blocking\\)$`));
    expect(code).toBe(1); // an empty reply fails at least one case
  });

  it('defaults to every model staff can select (AGENT_MODEL_CHOICES): Haiku and Sonnet', async () => {
    const fetchSpy = spyFetch('ok');
    await main({ EVAL_ANTHROPIC_API_KEY: KEY, EVAL_RUNS: '1', EVAL_SUBSET: 'pr' }, asFetch(fetchSpy), () => {});
    expect(fetchSpy).toHaveBeenCalledTimes(PR_SUBSET_IDS.length * AGENT_MODEL_CHOICES.length);
    const models = new Set(fetchSpy.mock.calls.map(([, init]) => bodyOf(init).model));
    expect([...models].sort()).toEqual([...AGENT_MODEL_CHOICES].sort());
  });

  it('EVAL_RUNS=3 calls the model 3 times per case (the PR subset: 20 cases)', async () => {
    const fetchSpy = spyFetch('ok');
    await main({ ...ONE, EVAL_RUNS: '3', EVAL_SUBSET: 'pr' }, asFetch(fetchSpy), () => {});
    expect(PR_SUBSET_IDS.length).toBe(20);
    expect(fetchSpy).toHaveBeenCalledTimes(20 * 3);
  });

  it('EVAL_RUNS defaults to 3', () => {
    const cfg = parseEvalConfig({});
    expect(cfg.ok && cfg.config.runs).toBe(3);
  });

  it('an overload fallback to another model is a failed run, never counted for the model under test', async () => {
    const fetchSpy = vi.fn(async (_u: string | URL | Request, init?: RequestInit) =>
      bodyOf(init).model === HAIKU
        ? new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }), { status: 529, headers: { 'content-type': 'application/json' } })
        : claudeReply('ok', SONNET),
    );
    const lines: string[] = [];
    const code = await main({ ...ONE, EVAL_MAX_RETRIES: '0' }, asFetch(fetchSpy), (l) => lines.push(l), { cases: [scripted(1, [1])] });
    expect(code).toBe(1);
    expect(fetchSpy.mock.calls.every(([, init]) => bodyOf(init).model === HAIKU)).toBe(true);
    expect(lines.join('\n')).toMatch(/FAIL #1/);
  });
});

describe('the pass policy (Q-R31.1): 2 of 3, critical 3 of 3, pending never blocks', () => {
  it('requiredPasses', () => {
    expect(requiredPasses(3, false)).toBe(2);
    expect(requiredPasses(3, true)).toBe(3);
    expect(requiredPasses(1, false)).toBe(1);
    expect(requiredPasses(1, true)).toBe(1);
    expect(requiredPasses(5, false)).toBe(4);
  });

  const run = (cases: EvalCase[], lines: string[] = []) =>
    main({ ...ONE, EVAL_RUNS: '3' }, asFetch(spyFetch('ok')), (l) => lines.push(l), { cases });

  it('a non-critical case passing 2 of 3 passes', async () => {
    expect(await run([scripted(1, [1, 3])])).toBe(0);
  });

  it('a critical case passing 2 of 3 fails', async () => {
    const lines: string[] = [];
    expect(await run([scripted(1, [1, 3], { category: 'tipping_off', critical: true })], lines)).toBe(1);
    expect(lines.join('\n')).toMatch(/FAIL #1 .*2\/3.*critical/);
  });

  it('a case passing 1 of 3 fails', async () => {
    expect(await run([scripted(1, [2])])).toBe(1);
  });

  it('a failing pending case is reported but does not change the exit code', async () => {
    const lines: string[] = [];
    expect(await run([scripted(1, [1, 2, 3]), scripted(2, [], { pending: 'R16' })], lines)).toBe(0);
    expect(lines.join('\n')).toMatch(/PENDING #2 .*0\/3.*R16/);
    expect(lines.at(-1)).toBe('eval-bot: 1/1 passed; pending 0/1 (not blocking)');
  });

  it('runs that the time budget never started count as failed runs', async () => {
    let t = 0;
    const lines: string[] = [];
    const now = () => (t += 60_000); // every clock read is one minute later
    const code = await main({ ...ONE, EVAL_RUNS: '3', EVAL_TIME_BUDGET_MIN: '2' }, asFetch(spyFetch('ok')), (l) => lines.push(l), {
      cases: [scripted(1, [1, 2, 3])],
      now,
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/time budget/);
  });
});

describe('the dated report (EVAL_REPORT_DIR)', () => {
  const NOW = Date.UTC(2026, 9, 31, 4, 50);
  const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

  it('reportBaseName is eval-<UTC date>-<sha7>, or local without a sha', () => {
    expect(reportBaseName(NOW, SHA)).toBe('eval-2026-10-31-abcdef0');
    expect(reportBaseName(NOW, undefined)).toBe('eval-2026-10-31-local');
    expect(reportBaseName(NOW, 'not a sha')).toBe('eval-2026-10-31-local');
  });

  it('writes the JSON and Markdown report: sha, models, prompt hash, per-case per-model counts; never the key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalrep-'));
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    try {
      // The model echoes the key: the report and the logs must still never hold it.
      const fetchSpy = spyFetch(`here is the key ${KEY}`);
      const lines: string[] = [];
      const cases = casesFor('pr').slice(0, 3);
      const code = await main(
        { EVAL_ANTHROPIC_API_KEY: KEY, EVAL_RUNS: '2', EVAL_REPORT_DIR: dir, GITHUB_SHA: SHA, GITHUB_STEP_SUMMARY: summary, EVAL_REQUIRED: '1' },
        asFetch(fetchSpy),
        (l) => lines.push(l),
        { cases, now: () => NOW },
      );
      expect([0, 1]).toContain(code);
      expect(readdirSync(dir).sort()).toEqual(['eval-2026-10-31-abcdef0.json', 'eval-2026-10-31-abcdef0.md', 'summary.md']);
      const jsonText = readFileSync(join(dir, 'eval-2026-10-31-abcdef0.json'), 'utf8');
      const mdText = readFileSync(join(dir, 'eval-2026-10-31-abcdef0.md'), 'utf8');
      for (const t of [jsonText, mdText, readFileSync(summary, 'utf8'), lines.join('\n')]) expect(t).not.toContain(KEY);
      const report = JSON.parse(jsonText) as {
        schema: string;
        sha: string;
        generated_at: string;
        models: string[];
        runs: number;
        required: boolean;
        policy: { pass_at: number; critical_pass_at: number };
        prompt_hashes: string[];
        verdict: string;
        cases: Array<{ id: number; category: string; lang: string; prompt_hash: string; models: Record<string, { passes: number; runs: number; required: number; verdict: string; excerpts: string[] }> }>;
      };
      expect(report.schema).toBe('smartremit.bot-eval/1');
      expect(report.sha).toBe(SHA);
      expect(report.generated_at).toBe('2026-10-31T04:50:00.000Z');
      expect(report.models).toEqual([...AGENT_MODEL_CHOICES]);
      expect(report.runs).toBe(2);
      expect(report.required).toBe(true);
      expect(report.policy).toMatchObject({ pass_at: 2, critical_pass_at: 2 });
      expect(report.prompt_hashes.length).toBeGreaterThan(0);
      for (const h of report.prompt_hashes) expect(h).toMatch(/^p1:[0-9a-f]{64}$/);
      expect(report.cases.map((c) => c.id)).toEqual(cases.map((c) => c.id));
      for (const c of report.cases) {
        expect(report.prompt_hashes).toContain(c.prompt_hash);
        expect(Object.keys(c.models).sort()).toEqual([...AGENT_MODEL_CHOICES].sort());
        for (const m of Object.values(c.models)) {
          expect(m.runs).toBe(2);
          expect(m.passes).toBeGreaterThanOrEqual(0);
          for (const e of m.excerpts) expect(e.length).toBeLessThanOrEqual(EVAL_EXCERPT_MAX);
        }
      }
      expect(mdText).toContain('# Bot eval report 2026-10-31 (abcdef0)');
      expect(mdText).toMatch(/## By category/);
      expect(mdText).toMatch(/## By language/);
      expect(readFileSync(summary, 'utf8')).toContain('# Bot eval report 2026-10-31 (abcdef0)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('makeEvalChat', () => {
  it('takes an explicit model; else EVAL_ANTHROPIC_MODEL; else the default', async () => {
    const fetchSpy = spyFetch('ok');
    await makeEvalChat({ EVAL_ANTHROPIC_API_KEY: 'k', EVAL_ANTHROPIC_MODEL: HAIKU }, asFetch(fetchSpy), SONNET)([{ role: 'user', content: 'hi' }], []);
    await makeEvalChat({ EVAL_ANTHROPIC_API_KEY: 'k', EVAL_ANTHROPIC_MODEL: SONNET }, asFetch(fetchSpy))([{ role: 'user', content: 'hi' }], []);
    await makeEvalChat({ EVAL_ANTHROPIC_API_KEY: 'k' }, asFetch(fetchSpy))([{ role: 'user', content: 'hi' }], []);
    expect(fetchSpy.mock.calls.map(([, init]) => bodyOf(init).model)).toEqual([SONNET, SONNET, EVAL_DEFAULT_MODEL]);
  });

  it('EVAL_ANTHROPIC_MODEL alone still picks the model under test when EVAL_MODELS is unset', () => {
    const cfg = parseEvalConfig({ EVAL_ANTHROPIC_MODEL: SONNET });
    expect(cfg.ok && cfg.config.models).toEqual([SONNET]);
  });

  it('a model HTTP error is a failed case, not a crash', async () => {
    const failing = asFetch(async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'x' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const chat = makeEvalChat({ EVAL_ANTHROPIC_API_KEY: 'k' }, failing);
    const results = await runEval(chat, EVAL_CASES.slice(0, 1));
    expect(results[0].failures).toEqual(['model call failed']);
  });
});

describe('runEval', () => {
  it('returns one result per case per run, in case order, carrying category, lang and the prompt hash', async () => {
    const cases = EVAL_CASES.slice(0, 3);
    const results = await runEval(async () => ({ role: 'assistant', content: 'ok' }), cases, { runs: 2, concurrency: 3 });
    expect(results.map((r) => [r.id, r.run])).toEqual([[1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [3, 2]]);
    for (const r of results) {
      const c = cases.find((x) => x.id === r.id)!;
      expect(r.category).toBe(c.category);
      expect(r.lang).toBe(c.lang);
      expect(r.promptHash).toMatch(/^p1:[0-9a-f]{64}$/);
    }
  });

  it('a failing run carries a reply excerpt of at most 300 characters', async () => {
    const long = 'x'.repeat(1000);
    const [r] = await runEval(async () => ({ role: 'assistant', content: long }), [scripted(1, [])]);
    expect(r.excerpt!.length).toBeLessThanOrEqual(EVAL_EXCERPT_MAX);
    expect(EVAL_EXCERPT_MAX).toBe(300);
    expect(replyExcerpt({ role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_quote', arguments: '{"amount_source":5}' } }] })).toBe(
      '[tool get_quote {"amount_source":5}]',
    );
  });
});

describe('the recorded cases prove their own checks', () => {
  it.each(EVAL_CASES.map((c) => [c.id, c.title, c] as const))('#%s %s', async (_id, _t, c) => {
    const replay = (m: ChatMessage): ChatFn => async () => m;
    const [pass] = await runEval(replay(c.recorded.pass), [c]);
    expect(pass.failures, 'recorded pass').toEqual([]);
    const [bad] = await runEval(replay(c.recorded.fail), [c]);
    expect(bad.failures.length, 'recorded fail').toBeGreaterThan(0);
  });

  it('the model sees the real system prompt first and only the WhatsApp tools', async () => {
    const seen: Array<{ first: ChatMessage; toolNames: string[] }> = [];
    await runEval(async (messages, tools) => {
      seen.push({ first: messages[0], toolNames: tools.map((t) => t.function.name) });
      return { role: 'assistant', content: 'ok' };
    }, EVAL_CASES.slice(0, 1));
    expect(seen[0].first.role).toBe('system');
    expect(seen[0].first.content).toContain('You are the AI assistant for SmartRemit.');
    expect(seen[0].toolNames).not.toContain('create_transfer');
  });

  it('a required-purpose case sees the PURPOSE section and a picker that requires purpose; the others do not', async () => {
    const seen = new Map<number, { prompt: string; pickerRequired: string[] }>();
    const required = EVAL_CASES.find((c) => c.purposeRequired)!;
    const plain = EVAL_CASES.find((c) => !c.purposeRequired)!;
    for (const c of [required, plain]) {
      await runEval(async (messages, tools) => {
        const picker = tools.find((t) => t.function.name === 'send_approve_picker')!;
        seen.set(c.id, {
          prompt: String(messages[0].content),
          pickerRequired: (picker.function.parameters as { required?: string[] }).required ?? [],
        });
        return { role: 'assistant', content: 'ok' };
      }, [c]);
    }
    expect(seen.get(required.id)!.prompt).toContain('PURPOSE\n');
    expect(seen.get(required.id)!.pickerRequired).toContain('purpose');
    expect(seen.get(plain.id)!.prompt).not.toContain('PURPOSE\n');
    expect(seen.get(plain.id)!.pickerRequired).not.toContain('purpose');
  });
});
