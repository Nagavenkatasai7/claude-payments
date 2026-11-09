import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anthropicSdkVersion, EVAL_SCOPE_FILES, evalScope, isEvalScopePath, runEvalScope } from '../scripts/ci/eval-scope.mjs';

// scripts/ci/eval-scope.mjs, the first step of ci.yml's `bot eval` job (R31).
// It decides whether a pull request changes what the bot model sees or how it
// is called, so the real-model eval runs only then. Git only: no network, no
// secrets. It always exits 0; it only writes in_scope to GITHUB_OUTPUT.

const pkg = (sdk: string, other = '1.0.0') =>
  JSON.stringify({ name: 'x', dependencies: { '@anthropic-ai/sdk': sdk, 'left-pad': other } }, null, 2);
const lock = (sdk: string, other = '1.0.0') =>
  JSON.stringify(
    { name: 'x', lockfileVersion: 3, packages: { '': {}, 'node_modules/@anthropic-ai/sdk': { version: sdk }, 'node_modules/left-pad': { version: other } } },
    null,
    2,
  );

describe('isEvalScopePath', () => {
  it.each([
    'src/lib/prompt.ts',
    'src/lib/tools.ts',
    'src/lib/agent.ts',
    'src/lib/agent-fallback.ts',
    'src/lib/llm.ts',
    'src/lib/llm-models.ts',
    'src/lib/llm-translate.ts',
    'src/lib/purpose-detail.ts',
    'src/lib/purpose-codes.ts',
    'src/lib/voice-notes.ts',
    'src/lib/whatsapp-format.ts',
    'src/lib/untrusted-text.ts',
    'src/lib/tool-context.ts',
    'src/lib/hold-replies.ts',
    'src/lib/model-visible-result.ts',
    'src/lib/inbound-redact.ts',
    'src/lib/ai-provenance.ts',
    'scripts/eval-bot.ts',
    'scripts/eval-bot-cases.ts',
    'scripts/ci/eval-scope.mjs',
  ])('%s is in scope', (p) => {
    expect(isEvalScopePath(p)).toBe(true);
  });

  it.each([
    'README.md',
    'docs/BOT-EVAL.md',
    'tests/prompt.test.ts',
    'tests/eval/eval-bot.test.ts',
    'src/lib/promptx.ts',
    'src/lib/mcp/tools.ts',
    'src/app/page.tsx',
    'lib/prompt.ts',
    'src/lib/prompt.ts.bak',
    'package.json',
  ])('%s is not in scope by path', (p) => {
    expect(isEvalScopePath(p)).toBe(false);
  });

  it('every listed file exists in this repo (a rename must update the list)', () => {
    const root = join(__dirname, '..');
    for (const f of EVAL_SCOPE_FILES) expect(existsSync(join(root, f)), f).toBe(true);
  });
});

describe('anthropicSdkVersion', () => {
  it('reads the declared range and the locked version', () => {
    expect(anthropicSdkVersion(pkg('0.135.0'), lock('0.135.0'))).toEqual({ declared: '0.135.0', resolved: '0.135.0' });
  });

  it('reads a devDependency too, and null for a missing or unreadable file', () => {
    expect(anthropicSdkVersion(JSON.stringify({ devDependencies: { '@anthropic-ai/sdk': '^0.1.0' } }), '')).toEqual({ declared: '^0.1.0', resolved: null });
    expect(anthropicSdkVersion('not json', 'not json')).toEqual({ declared: null, resolved: null });
  });
});

describe('evalScope', () => {
  const same = { pkg: pkg('0.135.0'), lock: lock('0.135.0') };

  it('a prompt.ts change is in scope', () => {
    const r = evalScope({ changedPaths: ['src/lib/prompt.ts', 'README.md'], base: same, head: same });
    expect(r.inScope).toBe(true);
    expect(r.reasons).toEqual(['src/lib/prompt.ts']);
  });

  it('a README change is not', () => {
    expect(evalScope({ changedPaths: ['README.md'], base: same, head: same })).toEqual({ inScope: false, reasons: [] });
  });

  it('an empty diff is not', () => {
    expect(evalScope({ changedPaths: [], base: same, head: same })).toEqual({ inScope: false, reasons: [] });
  });

  it('an @anthropic-ai/sdk bump is in scope', () => {
    const r = evalScope({ changedPaths: ['package.json', 'package-lock.json'], base: same, head: { pkg: pkg('0.136.0'), lock: lock('0.136.0') } });
    expect(r.inScope).toBe(true);
    expect(r.reasons).toEqual(['@anthropic-ai/sdk 0.135.0 -> 0.136.0']);
  });

  it('a lockfile-only SDK bump (the range already allowed it) is in scope', () => {
    const r = evalScope({ changedPaths: ['package-lock.json'], base: same, head: { pkg: pkg('0.135.0'), lock: lock('0.135.1') } });
    expect(r.inScope).toBe(true);
  });

  it('an unrelated package bump is not', () => {
    const r = evalScope({ changedPaths: ['package.json', 'package-lock.json'], base: same, head: { pkg: pkg('0.135.0', '2.0.0'), lock: lock('0.135.0', '2.0.0') } });
    expect(r).toEqual({ inScope: false, reasons: [] });
  });

  it('an unreadable package file that changed counts as in scope (the safe answer)', () => {
    const r = evalScope({ changedPaths: ['package.json'], base: same, head: { pkg: '{', lock: same.lock } });
    expect(r.inScope).toBe(true);
    expect(r.reasons[0]).toMatch(/could not read/);
  });
});

// End to end over a throwaway git repo: the PR's diff is merge-base..head.
describe('runEvalScope', () => {
  let repo: string;
  let base: string;
  let lines: string[];
  let outputs: string[];
  const out = (l: string) => lines.push(l);
  const writeOutput = (l: string) => outputs.push(l);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  const commitAll = (msg: string) => {
    git('add', '-A');
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  const write = (p: string, body: string) => {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), body);
  };
  const prEnv = (head: string) => ({ EVENT_NAME: 'pull_request', PR_BASE_SHA: base, PR_HEAD_SHA: head });
  let fetchCalls: string[];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    lines = [];
    outputs = [];
    fetchCalls = [];
    globalThis.fetch = (async (url: string) => {
      fetchCalls.push(String(url));
      throw new Error('eval-scope must not call the network');
    }) as typeof fetch;
    repo = mkdtempSync(join(tmpdir(), 'evalscope-'));
    git('init', '-q');
    write('src/lib/prompt.ts', 'export const P = 1;\n');
    write('README.md', 'x\n');
    write('package.json', pkg('0.135.0'));
    write('package-lock.json', lock('0.135.0'));
    base = commitAll('base');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    expect(fetchCalls).toEqual([]);
    rmSync(repo, { recursive: true, force: true });
  });

  it('a PR that edits prompt.ts writes in_scope=true and exits 0', async () => {
    git('checkout', '-q', '-b', 'pr');
    write('src/lib/prompt.ts', 'export const P = 2;\n');
    const head = commitAll('prompt');
    expect(await runEvalScope({ env: prEnv(head), cwd: repo, out, writeOutput })).toBe(0);
    expect(outputs).toEqual(['in_scope=true']);
    expect(lines.join('\n')).toContain('src/lib/prompt.ts');
  });

  it('a PR that edits only the README writes in_scope=false and exits 0', async () => {
    git('checkout', '-q', '-b', 'pr');
    write('README.md', 'y\n');
    const head = commitAll('docs');
    expect(await runEvalScope({ env: prEnv(head), cwd: repo, out, writeOutput })).toBe(0);
    expect(outputs).toEqual(['in_scope=false']);
  });

  it('diffs against the merge base: a later main change to prompt.ts does not put a docs PR in scope', async () => {
    git('checkout', '-q', '-b', 'pr');
    write('README.md', 'y\n');
    const head = commitAll('docs');
    git('checkout', '-q', '-');
    write('src/lib/prompt.ts', 'export const P = 3;\n');
    base = commitAll('main moved');
    expect(await runEvalScope({ env: prEnv(head), cwd: repo, out, writeOutput })).toBe(0);
    expect(outputs).toEqual(['in_scope=false']);
  });

  it('an SDK bump is in scope', async () => {
    git('checkout', '-q', '-b', 'pr');
    write('package.json', pkg('0.136.0'));
    write('package-lock.json', lock('0.136.0'));
    const head = commitAll('bump');
    expect(await runEvalScope({ env: prEnv(head), cwd: repo, out, writeOutput })).toBe(0);
    expect(outputs).toEqual(['in_scope=true']);
    expect(lines.join('\n')).toContain('@anthropic-ai/sdk 0.135.0 -> 0.136.0');
  });

  it('push and other events are out of scope (the nightly covers main)', async () => {
    expect(await runEvalScope({ env: { EVENT_NAME: 'push' }, cwd: repo, out, writeOutput })).toBe(0);
    expect(outputs).toEqual(['in_scope=false']);
  });

  it('merge_group uses the merge-group SHAs', async () => {
    git('checkout', '-q', '-b', 'pr');
    write('src/lib/prompt.ts', 'export const P = 4;\n');
    const head = commitAll('prompt');
    expect(await runEvalScope({ env: { EVENT_NAME: 'merge_group', MG_BASE_SHA: base, MG_HEAD_SHA: head }, cwd: repo, out, writeOutput })).toBe(0);
    expect(outputs).toEqual(['in_scope=true']);
  });

  it('a missing SHA or a commit missing from the clone runs the eval (in scope) with a warning, still exit 0', async () => {
    expect(await runEvalScope({ env: { EVENT_NAME: 'pull_request' }, cwd: repo, out, writeOutput })).toBe(0);
    expect(await runEvalScope({ env: prEnv('f'.repeat(40)), cwd: repo, out, writeOutput })).toBe(0);
    expect(outputs).toEqual(['in_scope=true', 'in_scope=true']);
    expect(lines.filter((l) => l.startsWith('::warning')).length).toBe(2);
  });
});
