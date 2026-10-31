#!/usr/bin/env node
/**
 * Does this pull request change the bot model's behaviour? (R31, ci.yml `bot eval`.)
 *
 * The real-model bot eval (scripts/eval-bot.ts) costs API calls, so the PR
 * job runs it only when the change touches what the model is told or how it
 * is called: the system prompt, the tool schemas and their results, the agent
 * loop, the model settings, the text the prompt is built from, the eval itself,
 * or the @anthropic-ai/sdk version. Everything else is out of scope and the
 * job finishes in seconds. The nightly run evaluates main regardless.
 *
 *   node scripts/ci/eval-scope.mjs
 *
 * Env: EVENT_NAME (pull_request | merge_group; anything else is out of scope),
 * PR_BASE_SHA/PR_HEAD_SHA or MG_BASE_SHA/MG_HEAD_SHA (base/head resolution as
 * in scripts/ci/migration-guard.mjs), GITHUB_OUTPUT. Writes `in_scope=true` or
 * `in_scope=false` to GITHUB_OUTPUT and ALWAYS exits 0, so the job never shows
 * as skipped or red for scope reasons. When the diff cannot be read (missing
 * SHA, shallow clone) the answer is in scope: running the eval is the safe
 * default for a gate. Reads git only: no network, no secrets.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Files that shape the model's instructions, inputs or call (and the eval). */
export const EVAL_SCOPE_FILES = Object.freeze([
  // The system prompt and the text it is built from.
  'src/lib/prompt.ts',
  'src/lib/purpose-codes.ts',
  'src/lib/purpose-detail.ts',
  'src/lib/hold-replies.ts',
  'src/lib/inbound-redact.ts',
  'src/lib/untrusted-text.ts',
  // Tool schemas, tool results and what of them the model sees.
  'src/lib/tools.ts',
  'src/lib/tool-context.ts',
  'src/lib/model-visible-result.ts',
  // The agent loop, its fallback and its message formatting.
  'src/lib/agent.ts',
  'src/lib/agent-fallback.ts',
  'src/lib/voice-notes.ts',
  'src/lib/whatsapp-format.ts',
  // The model call and the model settings.
  'src/lib/llm.ts',
  'src/lib/llm-models.ts',
  'src/lib/llm-translate.ts',
  // The eval itself.
  'src/lib/ai-provenance.ts',
  'scripts/eval-bot.ts',
  'scripts/eval-bot-cases.ts',
  'scripts/ci/eval-scope.mjs',
]);

const SCOPE = new Set(EVAL_SCOPE_FILES);
const SDK = '@anthropic-ai/sdk';
const PACKAGE_FILES = new Set(['package.json', 'package-lock.json']);

/** @param {string} path */
export function isEvalScopePath(path) {
  return SCOPE.has(path) || /^scripts\/eval-bot[^/]*\.ts$/.test(path);
}

/** @param {string} text */
function parseJson(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The SDK range package.json declares and the version package-lock.json locks.
 * @param {string} pkgText @param {string} lockText
 * @returns {{declared: string | null, resolved: string | null}}
 */
export function anthropicSdkVersion(pkgText, lockText) {
  const pkg = parseJson(pkgText);
  const lock = parseJson(lockText);
  const declared = pkg?.dependencies?.[SDK] ?? pkg?.devDependencies?.[SDK] ?? null;
  const resolved = lock?.packages?.[`node_modules/${SDK}`]?.version ?? null;
  return { declared: typeof declared === 'string' ? declared : null, resolved: typeof resolved === 'string' ? resolved : null };
}

/**
 * @param {{
 *   changedPaths: string[],
 *   base: {pkg?: string, lock?: string},
 *   head: {pkg?: string, lock?: string},
 * }} input
 * @returns {{inScope: boolean, reasons: string[]}}
 */
export function evalScope({ changedPaths, base, head }) {
  const reasons = changedPaths.filter(isEvalScopePath);
  if (changedPaths.some((p) => PACKAGE_FILES.has(p))) {
    const unreadable = changedPaths.filter((p) => PACKAGE_FILES.has(p)).filter((p) => {
      const key = p === 'package.json' ? 'pkg' : 'lock';
      return parseJson(head[key] ?? '') === null || parseJson(base[key] ?? '') === null;
    });
    if (unreadable.length > 0) {
      reasons.push(`could not read ${unreadable.join(', ')} to compare the ${SDK} version`);
    } else {
      const was = anthropicSdkVersion(base.pkg ?? '', base.lock ?? '');
      const now = anthropicSdkVersion(head.pkg ?? '', head.lock ?? '');
      if (was.declared !== now.declared || was.resolved !== now.resolved) {
        reasons.push(`${SDK} ${was.resolved ?? was.declared ?? 'none'} -> ${now.resolved ?? now.declared ?? 'none'}`);
      }
    }
  }
  return { inScope: reasons.length > 0, reasons };
}

// GitHub workflow-command escaping (data and properties).
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const annotate = (level, msg, title) => `::${level} title=${escProp(title)}::${esc(msg)}`;

/** @param {Record<string, string | undefined>} env */
function defaultWriteOutput(env) {
  return (line) => {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${line}\n`);
  };
}

/**
 * @param {{
 *   env: Record<string, string | undefined>,
 *   cwd?: string,
 *   out?: (line: string) => void,
 *   writeOutput?: (line: string) => void,
 * }} opts
 * @returns {Promise<0>}
 */
export async function runEvalScope({ env, cwd = process.cwd(), out = console.log, writeOutput = defaultWriteOutput(env) }) {
  const answer = (inScope) => {
    writeOutput(`in_scope=${inScope ? 'true' : 'false'}`);
    return /** @type {0} */ (0);
  };
  const event = env.EVENT_NAME ?? '';
  let baseRef;
  let headRef;
  if (event === 'pull_request') [baseRef, headRef] = [env.PR_BASE_SHA, env.PR_HEAD_SHA];
  else if (event === 'merge_group') [baseRef, headRef] = [env.MG_BASE_SHA, env.MG_HEAD_SHA];
  else {
    out(`Bot eval scope: event ${event || 'none'} is not a pull request; the nightly run evaluates main. Out of scope.`);
    return answer(false);
  }

  const unsure = (msg) => {
    out(annotate('warning', `${msg} Running the bot eval to be safe.`, 'Bot eval scope unknown'));
    return answer(true);
  };
  if (!/^[0-9a-f]{40}$/i.test(baseRef ?? '') || !/^[0-9a-f]{40}$/i.test(headRef ?? '')) {
    return unsure('The base and head commits of this change are missing from the event.');
  }
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let mergeBase;
  let changedPaths;
  try {
    mergeBase = git('merge-base', baseRef, headRef).trim();
    changedPaths = git('diff', '--name-only', '--no-renames', mergeBase, headRef).split('\n').filter(Boolean);
  } catch {
    return unsure(`Commit ${baseRef.slice(0, 7)} or ${headRef.slice(0, 7)} is not in the clone (checkout needs fetch-depth: 0).`);
  }
  const show = (ref, path) => {
    try {
      return git('show', `${ref}:${path}`);
    } catch {
      return '';
    }
  };
  const result = evalScope({
    changedPaths,
    base: { pkg: show(mergeBase, 'package.json'), lock: show(mergeBase, 'package-lock.json') },
    head: { pkg: show(headRef, 'package.json'), lock: show(headRef, 'package-lock.json') },
  });
  if (result.inScope) {
    out(`Bot eval scope: in scope (${result.reasons.length} reason${result.reasons.length === 1 ? '' : 's'}):`);
    for (const r of result.reasons) out(`  ${r}`);
  } else {
    out(`Bot eval scope: out of scope (${changedPaths.length} changed file${changedPaths.length === 1 ? '' : 's'}, none the bot model depends on).`);
  }
  return answer(result.inScope);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  runEvalScope({ env }).then(
    (code) => process.exit(code),
    (e) => {
      // Never red for scope reasons: a crash runs the eval instead.
      console.log(annotate('warning', `eval-scope crashed (${e instanceof Error ? e.name : 'unknown'}); running the bot eval to be safe.`, 'Bot eval scope unknown'));
      try {
        defaultWriteOutput(env)('in_scope=true');
      } catch {
        // GITHUB_OUTPUT unwritable: the step's `if` sees no output and skips the eval.
      }
      process.exit(0);
    },
  );
}
