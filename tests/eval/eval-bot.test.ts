import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVAL_CASES,
  PR_SUBSET_IDS,
  casesFor,
  buildEvalMessages,
  runEval,
  replyExcerpt,
  EVAL_EXCERPT_MAX,
  type ChatFn,
  type EvalCase,
} from '../../scripts/eval-bot-cases';
import { main, makeEvalChat, EVAL_DEFAULT_MODEL, parseEvalConfig, requiredPasses, reportBaseName } from '../../scripts/eval-bot';
import { AGENT_MODEL_CHOICES, HAIKU, SONNET } from '@/lib/llm-models';
import type { ChatMessage } from '@/lib/types';
import { ENGLISH_STEPS_SECTION, buildSystemPrompt } from '@/lib/prompt';
import { fixedReply } from '@/lib/hold-replies';

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

describe('buildEvalMessages and the English steps section (pack 6 P12)', () => {
  it('buildEvalMessages passes englishTransactionSteps only for an englishSteps case', () => {
    const byId = (id: number) => EVAL_CASES.find((c) => c.id === id)!;
    expect(String(buildEvalMessages(byId(60))[0].content)).toContain(ENGLISH_STEPS_SECTION);
    expect(String(buildEvalMessages(byId(61))[0].content)).toContain(ENGLISH_STEPS_SECTION);
    expect(String(buildEvalMessages(byId(18))[0].content)).not.toContain(ENGLISH_STEPS_SECTION);
    expect(buildEvalMessages(byId(18))[0].content).toBe(buildSystemPrompt({ brand: 'SmartRemit', kycGateActive: true, purposeRequired: false }));
  });
});

describe('cases 60 and 61 check the lead-in line their titles promise (review round 2 GD4)', () => {
  const byId = (id: number) => EVAL_CASES.find((c) => c.id === id)!;
  const say = (content: string): ChatMessage => ({ role: 'assistant', content });
  const failuresOf = async (id: number, text: string) => (await runEval(async () => say(text), [byId(id)]))[0].failures;
  const held = fixedReply('hold', { help: true });

  it('case 60 fails with no lead-in line', async () => {
    expect(await failuresOf(60, held)).not.toEqual([]);
  });
  it('case 60 fails with an English lead-in line', async () => {
    expect(await failuresOf(60, `Here is the answer in English:\n${held}`)).not.toEqual([]);
  });
  it('case 60 fails with a Spanish line AFTER the status text instead of before it', async () => {
    expect(await failuresOf(60, `${held}\nLe dejo la respuesta en inglés.`)).not.toEqual([]);
  });
  it('case 60 passes with one Spanish lead-in line, then the status text', async () => {
    expect(await failuresOf(60, `Le dejo la respuesta en inglés:\n${held}`)).toEqual([]);
  });
  it('case 61 fails when the quote lead line is Hinglish', async () => {
    expect(await failuresOf(61, 'Aapka quote neeche hai.\nShall I go ahead?')).not.toEqual([]);
  });
  it('case 61 fails when the quote lead line is Hinglish and the English question names the quote (review round 2 F4-D1)', async () => {
    expect(await failuresOf(61, 'Aapka quote neeche hai.\nShall I go ahead with this quote?')).not.toEqual([]);
    expect(await failuresOf(61, 'Aapka quote neeche hai.\nShall I go ahead with these details?')).not.toEqual([]);
  });
  it('case 61 fails when the only English part is a question with a second opener after the lead word (final check R3 F7-D1)', async () => {
    expect(await failuresOf(61, 'Aapka quote neeche hai.\nShall I go ahead with the quote you can see above?')).not.toEqual([]);
    expect(await failuresOf(61, 'Aapka quote neeche hai.\nShall I go ahead with this quote, or would you like to change it?')).not.toEqual([]);
    expect(await failuresOf(61, 'Aapka quote neeche hai.\nShould I confirm these details, or can I change something?')).not.toEqual([]);
  });
  it('case 61 fails when the Hinglish line is not the first line', async () => {
    expect(await failuresOf(61, 'Here is your quote.\nAapka quote neeche hai.\nShall I go ahead?')).not.toEqual([]);
  });
  it('case 61 passes with an English quote lead line, with or without one Hinglish lead-in line first', async () => {
    expect(await failuresOf(61, 'Here is your quote. Shall I go ahead?')).toEqual([]);
    expect(await failuresOf(61, 'Aapka quote neeche hai, aage ka hissa English mein hai.\nHere is your quote.\nShall I go ahead?')).toEqual([]);
  });
  it('case 61 passes when the English quote lead and the question share one sentence joined by a comma (review round 2 R2-D1)', async () => {
    expect(await failuresOf(61, 'Here is your quote, shall I go ahead?')).toEqual([]);
    expect(await failuresOf(61, 'Aapka quote neeche hai, aage ka hissa English mein hai.\nHere is your quote, shall I go ahead?')).toEqual([]);
  });

  // Final check R4 R3-D1: the lead is decided per sentence; a question counts only from a
  // declarative lead start, up to its first clause boundary or opener, and only when that names the quote.
  const H = 'Aapka quote neeche hai.\n';
  it.each([
    ['Shall I go ahead?'],
    [`${H}Is this quote okay, or shall I change it?`],
    [`${H}Are these details correct, shall I go ahead?`],
    [`${H}Do these details look right, or should I change something?`],
    [`${H}Happy with this quote, or should I change the amount?`],
    [`${H}Want to go ahead with this quote, or shall I change it?`],
    [`${H}Shall I go ahead with this quote? Or should I change it?`],
    [`${H}Is this quote okay?\nShall I go ahead?`],
    [`${H}Here is what I need to know: is this quote okay, shall I go ahead?`],
    [`${H}This quote okay, or shall I change it?`],
    [`${H}These details look right, shall I go ahead?`],
    [`${H}Your quote okay, shall I go ahead?`],
    [`${H}Quote looks right, shall I go ahead?`],
    [`${H}Does the quote above look right? Should I confirm?`],
    [`${H}Can you see the quote above? Shall I go ahead?`],
    // Final check R5 R4-A-1/R4-B-1: markup or a missing space after a question mark keeps it a question.
    [`${H}*Is this quote okay?* Shall I go ahead?`],
    [`${H}(Is this quote okay?) Shall I go ahead?`],
    [`${H}Is this quote okay?Shall I go ahead?`],
  ])('case 61 fails when no English statement or declarative lead names the quote (final check R4 R3-D1): %j', async (text) => {
    expect(await failuresOf(61, text)).toContain('the quote lead line is not in English');
  });
  it('case 61 fails on the Hinglish position alone when an English statement leads (final check R5 R4-B-2)', async () => {
    const failures = await failuresOf(61, 'Here is your quote.\nAapka quote theek hai?\nShall I go ahead?');
    expect(failures).toContain('a Hinglish line is not the first line');
    expect(failures).not.toContain('the quote lead line is not in English');
  });
  // Final check R5 R4-A-1/R4-B-1: WhatsApp markup, a closing bracket or a missing space after the
  // full stop still ends the English statement, as it did at 200402e.
  it.each([
    [`${H}*Here is your quote.* Shall I go ahead?`],
    [`${H}*You can review the quote below.* Shall I go ahead?`],
    ['You can review the quote below.* Shall I go ahead?'],
    [`${H}(You can review the quote below.) Shall I go ahead?`],
    [`${H}You can review the quote below.Shall I go ahead?`],
    ['You can see the quote below.Shall I go ahead?'],
    [`${H}Please check the quote above.Shall I go ahead?`],
    [`${H}You can see your quote below.Shall I proceed?`],
    [`${H}*Here is your quote*, shall I go ahead?`],
  ])('case 61 passes when markup or a missing space follows the English statement (final check R5 R4-A-1, R4-B-1): %j', async (text) => {
    expect(await failuresOf(61, text)).toEqual([]);
  });
  // Final check R6 R5-1: a missing space ends the statement after any character, not only after
  // a lowercase letter (a capital, a digit, a bracket or an ellipsis), as it did at 200402e.
  it.each([
    [`${H}Check the quote in USD.Shall I go ahead?`],
    [`${H}You can see the quote for $200.Shall I go ahead?`],
    [`${H}You can see the quote below (in USD).Shall I go ahead?`],
    [`${H}You can see the quote below...Shall I go ahead?`],
    [`${H}You can see the quote below.OK to go ahead?`],
    // Control: the same ellipsis with a space still ends the statement (the space split, unchanged).
    [`${H}You can see the quote below... Shall I go ahead?`],
  ])('case 61 passes when a missing space follows a capital, a digit, a bracket or an ellipsis (final check R6 R5-1): %j', async (text) => {
    expect(await failuresOf(61, text)).toEqual([]);
  });
  // Truth check R6-1: with no space, the next sentence may also start with the word "I", and
  // after a lowercase letter and a mark with any capital ("above.USD"), as it did at 36ca861.
  it.each([
    [`${H}You can see the quote below.I can go ahead if you confirm, shall I?`],
    [`${H}Please review the quote above.I'll send it once you confirm, shall I go ahead?`],
    [`${H}Please review the quote above.I hope it looks good, shall I go ahead?`],
    [`${H}Please review the quote above.USD 200 goes to mummy, shall I go ahead?`],
    [`${H}Check the quote in USD.I can go ahead if you confirm, shall I?`],
  ])('case 61 passes when a missing space comes before "I" or, after a lowercase letter, before any capital (truth check R6-1): %j', async (text) => {
    expect(await failuresOf(61, text)).toEqual([]);
  });
  // The documented limits of the sentence splitter (scripts/eval-bot-cases.ts, the comment of case
  // 61). They are pinned so that a later change of the splitter has to decide about them.
  it('case 61 keeps the documented limits of its sentence splitter (truth check R6-1, R6-2)', async () => {
    const LEAD = 'the quote lead line is not in English';
    // A statement that ends with a bracketed question counts as a question.
    expect(await failuresOf(61, `${H}You can see the quote below (any questions?). Shall I go ahead?`)).toContain(LEAD);
    // With no space, an all-capitals word starts a sentence only after a lowercase letter and a mark.
    expect(await failuresOf(61, `${H}Check the quote in USD.USD 200 goes to mummy, shall I go ahead?`)).toContain(LEAD);
    // An abbreviation's full stop ends a sentence, so the first part of this question counts as a statement.
    expect(await failuresOf(61, `${H}Do you want this quote in U.S. dollars? Shall I go ahead?`)).not.toContain(LEAD);
  });
  // Final check R6 R5-1, the other side: the wider split makes no question a statement. A
  // sentence is a question when its closing run of marks holds a "?" ("?!", "?...", "?)."), and a
  // decimal point does not split.
  it.each([
    [`${H}Is this quote in USD?Shall I go ahead?`],
    [`${H}Is the $200.00 quote okay? Shall I go ahead?`],
    [`${H}Is this quote okay (in USD)?Shall I go ahead?`],
    [`${H}Is this quote OK?OK to go ahead?`],
    [`${H}Is this quote okay?!Shall I go ahead?`],
    [`${H}Is this quote okay?! Shall I go ahead?`],
    [`${H}Is this quote okay?...Shall I go ahead?`],
    [`${H}Is this quote okay?... Shall I go ahead?`],
    [`${H}(Is this quote okay?). Shall I go ahead?`],
  ])('case 61 still fails when a question has no space before the next sentence (final check R6 R5-1): %j', async (text) => {
    expect(await failuresOf(61, text)).toContain('the quote lead line is not in English');
  });
  it.each([
    ['Here are the details you can check, shall I go ahead?'],
    ['You can review the quote below. Shall I go ahead?'],
    ['Here is your quote.\nShall I go ahead?'],
    [`${H}Your quote is ready, shall I go ahead?`],
    [`${H}Okay, here's the breakdown - shall I go ahead?`],
    [`${H}I've prepared your quote, should I confirm it?`],
    [`${H}Here is your quote. Does everything look right? Shall I go ahead?`],
    [`${H}Here is your quote so shall I go ahead?`],
    [`${H}Below are the details. Shall I proceed?`],
  ])('case 61 passes with an English statement or declarative lead that names the quote (final check R4 R3-D1): %j', async (text) => {
    expect(await failuresOf(61, text)).toEqual([]);
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
