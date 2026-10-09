#!/usr/bin/env node
/**
 * Parser for `/ops` comment commands (.github/workflows/ops-commands.yml).
 *
 * Thread agents write to GitHub as the owner through an App token that has no
 * Actions write, so they cannot re-run, cancel or dispatch a workflow. A
 * comment on an issue labelled `ops` can: that workflow's GITHUB_TOKEN has
 * `actions: write`. The workflow only runs for the owner's own comments; this
 * script turns the comment's FIRST line into a fixed command, and anything
 * that does not match the exact grammar is ignored:
 *
 *   /ops rerun <run id>        re-run the failed jobs of a run
 *   /ops rerun-all <run id>    re-run every job of a run
 *   /ops cancel <run id>       cancel a run
 *   /ops smoke [<40-hex sha>]  dispatch smoke.yml on main (optionally for a commit)
 *
 * A run id is 1-20 ASCII digits without a leading zero and stays a string (a
 * 20-digit id is beyond Number precision). Only validated values reach
 * $GITHUB_OUTPUT, so the workflow's shell never sees the raw body.
 *
 *   node scripts/ci/ops-command.mjs
 *
 * Env: COMMENT_BODY, GITHUB_OUTPUT. Writes `cmd=`, `run_id=`, `sha=` lines.
 * Exit 0 (a command, or "no command"), 1 when a command parsed but there is
 * no GITHUB_OUTPUT to write it to.
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{cmd: 'rerun' | 'rerun-all' | 'cancel', runId: string} | {cmd: 'smoke', sha?: string}} OpsCommand
 */

// [0-9] and [0-9a-f], never \d or \s: only ASCII digits and single spaces pass.
const RUN_CMD = /^\/ops (rerun|rerun-all|cancel) ([1-9][0-9]{0,19})$/;
const SMOKE_CMD = /^\/ops smoke(?: ([0-9a-fA-F]{40}))?$/;

/**
 * @param {unknown} body the raw comment body
 * @returns {OpsCommand | null}
 */
export function parseOpsCommand(body) {
  if (typeof body !== 'string') return null;
  const nl = body.indexOf('\n');
  // Only trailing spaces, tabs and the \r of a CRLF line end are dropped.
  const line = (nl < 0 ? body : body.slice(0, nl)).replace(/[ \t\r]+$/, '');
  const run = RUN_CMD.exec(line);
  if (run) return { cmd: /** @type {'rerun' | 'rerun-all' | 'cancel'} */ (run[1]), runId: run[2] };
  const smoke = SMOKE_CMD.exec(line);
  if (smoke) return smoke[1] ? { cmd: 'smoke', sha: smoke[1].toLowerCase() } : { cmd: 'smoke' };
  return null;
}

/**
 * The $GITHUB_OUTPUT lines for a parsed command.
 * @param {OpsCommand} command
 */
export function formatOutputs(command) {
  const runId = 'runId' in command ? command.runId : '';
  const sha = 'sha' in command && command.sha ? command.sha : '';
  return `cmd=${command.cmd}\nrun_id=${runId}\nsha=${sha}\n`;
}

/**
 * @param {{
 *   env: Record<string, string | undefined>,
 *   appendFile?: (path: string, text: string) => void,
 *   log?: (line: string) => void,
 * }} deps
 * @returns {number} exit code
 */
export function runCli({ env, appendFile = (p, t) => appendFileSync(p, t), log = (l) => console.log(l) }) {
  const command = parseOpsCommand(env.COMMENT_BODY ?? '');
  if (!command) {
    log('no command');
    return 0;
  }
  if (!env.GITHUB_OUTPUT) {
    log('::error::GITHUB_OUTPUT is not set');
    return 1;
  }
  appendFile(env.GITHUB_OUTPUT, formatOutputs(command));
  const target = 'runId' in command ? ` run ${command.runId}` : command.sha ? ` ${command.sha}` : '';
  log(`ops command: ${command.cmd}${target}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(runCli({ env: process.env }));
}
